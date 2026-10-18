# Lightweight LLM Gateway 完全リファレンス ＆ 開発者ガイド

## 1. 概要とアーキテクチャ設計思想

**Lightweight LLM Gateway** は、Webアプリケーション（SPA）、デスクトップアプリ、バックエンドサービスなどの各種クライアントと、外部クラウドLLMプロバイダ（OpenRouter, OpenAI, Anthropic, Google Gemini 等）および**ローカルLLM（LM Studio, Ollama, vLLM 等）**との通信を安全・高速に中継する**ローカル稼働型リバースプロキシ（C++20実装）**です。

```
┌─────────────────────────────────────────────────────────────┐
│ クライアント・アプリケーション (React, Python, Node, C#等) │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / REST (OpenAI互換)
                               │ Authorization: Bearer <Gateway Token>
                               ▼
┌─────────────────────────────────────────────────────────────┐
│            Lightweight LLM Gateway (127.0.0.1:8765)         │
│  ┌─────────────────────────┐   ┌─────────────────────────┐  │
│  │ 認証・トークン検証      │   │ モデル動的ルーティング  │  │
│  │ (Client Token Check)    │   │ provider/upstream_model │  │
│  └─────────────────────────┘   └─────────────────────────┘  │
│  ┌─────────────────────────┐   ┌─────────────────────────┐  │
│  │ Allowlist モデル遮断    │   │ SSE バックプレッシャー  │  │
│  │ (Default Deny セキュリティ)│ │ (16チャンクバッファ)   │  │
│  └─────────────────────────┘   └─────────────────────────┘  │
└──────────────┬─────────────────────────────┬────────────────┘
               │ 安全なキー解決              │ 転送 (APIキー自動付与/無認証切替)
               ▼                             ▼
┌────────────────────────────┐  ┌─────────────────────────────┐
│ OS 資格情報ストア          │  │ クラウド / ローカル LLM     │
│ (Windows DPAPI / Linux)    │  │ ・OpenRouter / OpenAI       │
│ ※ローカルLLMはキー不要     │  │ ・LM Studio (Local / VPN)   │
│                             │  │ ・Ollama (127.0.0.1:11434)  │
└────────────────────────────┘  └─────────────────────────────┘
```

### なぜ LLM Gateway を使うのか？
1. **APIキーの平文漏洩を完全防止**: 
   - クラウドプロバイダ（OpenRouter/OpenAI等）利用時、ソースコード、設定ファイル、環境変数、ブラウザ通信上にAPIキーを保存しません。
   - OSネイティブの暗号化資格情報ストア（Windows DPAPI / Linux Secret Service）から**リクエスト処理時にオンメモリで直接キーを解決**します。
2. **ローカルLLM（LM Studio / Ollama）とクラウドLLMのシームレス統合**:
   - ローカルPCの LM Studio や Ollama、Tailscale等のVPN経由で接続された別マシンの LM Studio を、同一のGatewayエンドポイント（OpenAI互換REST API）配下に束ねて切り替えられます。
3. **ブラウザSPAとのシームレス接続（CORS制御）**:
   - Webブラウザからの直接アクセスを想定した厳格なCORSプリフライト処理に対応。
4. **モデル利用制限（Allowlist / Default Deny）**:
   - 許可されていない高額モデルや不適切なモデルへのリクエストをGateway側で即座に403遮断します。
5. **最新修正版（v1.3.2）での強化点**:
   - **`Accept-Encoding` 透過制御**: ブラウザやプロキシからの gzip / chunked 通信に起因する zlib アサーション不具合を完全解消し、安定したSSEストリーミングを実現。

---

## 2. クイックスタート (5分で始める連携手順)

### ステップ1: 資格情報（APIキー）の登録（クラウド利用時のみ）
ローカルLLM（LM Studio / Ollama）のみを利用する場合は本ステップは不要です。OpenRouter等のクラウドAPIを利用する場合は登録します。

#### 方法A: GUI ツールを使う場合
1. `llm-gateway-credential-manager.exe` を起動します。
2. Service Name を設定ファイルと同じ `CloudLLM`（デフォルト）にします。
3. 以下の識別子で資格情報を登録します：
   - **Gateway Client Token**（クライアント認証用）: `llm_gateway|default`
   - **OpenRouter API Key**: `openrouter|default`
   - **OpenAI API Key**: `openai|default`

#### 方法B: Python から登録する場合
```python
import keyring

keyring.set_password("CloudLLM", "llm_gateway|default", "your-gateway-client-token")
keyring.set_password("CloudLLM", "openrouter|default", "sk-or-v1-xxxxxx")
```

---

### ステップ2: 設定ファイル (`gateway.json`) の準備
実行ファイルと同じディレクトリに `gateway.json` を配置します。

```json
{
  "listen": { "address": "127.0.0.1", "port": 8765 },
  "security": { "client_auth": false, "credential_name": "llm_gateway|default" },
  "credentials": { "service_name": "CloudLLM", "environment_fallback": false },
  "proxy": { "max_request_body_mb": 64, "connect_timeout_sec": 10, "read_timeout_sec": 600, "write_timeout_sec": 600 },
  "model_cache": { "enabled": true, "ttl_sec": 60 },
  "cors": {
    "enabled": true,
    "allowed_origins": ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"],
    "allowed_methods": ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    "allowed_headers": ["Authorization", "Content-Type"],
    "max_age_sec": 600
  },
  "providers": {
    // ローカル LM Studio
    "lmstudio": {
      "base_url": "http://127.0.0.1:1234/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "lmstudio/*" }]
    },
    // Tailscale 経由のリモート LM Studio
    "lmstudio_remote": {
      "base_url": "http://192.0.2.1:1234/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "lmstudio_remote/*" }]
    },
    // ローカル Ollama
    "ollama": {
      "base_url": "http://127.0.0.1:11434/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "ollama/*" }]
    },
    // クラウド OpenRouter
    "openrouter": {
      "base_url": "https://openrouter.ai/api",
      "authentication": "bearer",
      "key_vendor": "openrouter",
      "key_slot": "default",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "openrouter/*" }]
    }
  },
  "logging": { "level": "info", "file": "llm-gateway.log" }
}
```

---

### ステップ3: Gatewayの起動
```powershell
.\llm-gateway.exe .\gateway.json
```

---

### ステップ4: 疎通確認 (cURL)
利用可能なモデル一覧を取得（LM Studio, Ollama, OpenRouter すべて統合されて返されます）：
```powershell
curl.exe http://127.0.0.1:8765/v1/models
```

ローカル LM Studio へのチャット推論テスト：
```powershell
curl.exe http://127.0.0.1:8765/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{"model":"lmstudio/default","messages":[{"role":"user","content":"こんにちは"}],"stream":true}'
```

---

## 3. ローカルLLM（LM Studio / Ollama）の詳細設定ガイド

### 1. LM Studio との接続

LM Studio は標準で `http://127.0.0.1:1234/v1` で OpenAI 互換サーバーを提供しています。

#### (1) 設定のポイント
- **`base_url`**: `"http://127.0.0.1:1234/v1"`
- **`authentication`**: `"none"`（ローカルAPIキー認証は不要）
- **`model_discovery`**: `true`（ダウンロード済み・ロード可能モデル一覧を取得）

#### (2) LM Studio の2通りの利用方法
LM Studio には、クライアントからの呼び出し方として以下の2つのパターンがあります。Gatewayはいずれにも完全対応しています。

| 利用パターン | GatewayモデルID指定例 | 動作と特徴 |
| :--- | :--- | :--- |
| **A. ロード済みモデルの利用** | `lmstudio/default` または `lmstudio/loaded` | LM Studio のGUI上で**現在読み込まれているモデル**で即座に推論を実行します。モデル名を固定したくない場合や手動切替時に便利です。 |
| **B. モデル名を指定したJITロード** | `lmstudio/qwen2.5-7b-instruct`<br>`lmstudio/gemma-4-26b-a4b-it` | LM Studio にダウンロードされているモデル識別子を指定します。Gatewayがプレフィックス `lmstudio/` を除去してLM Studioに伝えることで、LM Studioが**自動で該当モデルをメモリにロードして推論**します。 |

---

### 2. Tailscale / LAN 経由のリモート LM Studio との接続

別マシンで起動している LM Studio に Tailscale VPN や社内LAN経由で接続する場合の設定です。

```jsonc
"lmstudio_remote": {
  "base_url": "http://192.0.2.1:1234/v1", // リモートマシンのTailscale IPまたはホスト名
  "authentication": "none",
  "model_discovery": true,
  "allowlist": [
    { "type": "glob", "pattern": "lmstudio_remote/*" }
  ]
}
```

- **呼び出し例**:
  - リモートのロード済みモデル: `lmstudio_remote/default`
  - リモートの指定モデル: `lmstudio_remote/qwen3.8-27b`

---

### 3. Ollama との接続

Ollama は標準で `http://127.0.0.1:11434/v1` で OpenAI 互換 API を提供しています。

```jsonc
"ollama": {
  "base_url": "http://127.0.0.1:11434/v1",
  "authentication": "none",
  "model_discovery": true,
  "allowlist": [
    { "type": "glob", "pattern": "ollama/*" }
  ]
}
```

- **呼び出し例**:
  - `ollama/llama3.2`
  - `ollama/qwen2.5:7b`
  - `ollama/deepseek-r1:8b`
  - `ollama/phi3:mini`

---

## 4. API仕様 ＆ モデルルーティング規約

LLM Gateway は **OpenAI REST API 互換** のインターフェースを提供します。

### 1. エンドポイント一覧

| メソッド | パス | 説明 |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | チャット推論の実行（通常応答 ＆ SSEストリーミング両対応） |
| `GET` | `/v1/models` | 利用可能なモデル一覧の動的取得（全Provider統合・Allowlist適用済み） |
| `OPTIONS`| 任意 | CORS プリフライト検証 |

### 2. 認証ヘッダー
`security.client_auth: true` の場合、クライアントは以下を付与します：
```http
Authorization: Bearer <Gateway Token>
```
※認証不要なプロバイダ（LM Studio, Ollama）へのリクエスト時も、Gateway自体のクライアント認証が有効な場合はClient Tokenを検証します。上流への転送時は不要な認証ヘッダーは安全に除去されます。

### 3. モデルIDのルーティング形式
リクエストボディの `"model"` には、必ず **`<provider_id>/<upstream_model_id>`** を指定します。

| GatewayモデルID指定例 | 振り分け先プロバイダ | 上流へ渡されるモデルID | 接続先エンドポイント |
| :--- | :--- | :--- | :--- |
| `lmstudio/default` | `lmstudio` | `default` (ロード中モデル実行) | `http://127.0.0.1:1234/v1/chat/completions` |
| `lmstudio/gemma-4-26b-a4b-it` | `lmstudio` | `gemma-4-26b-a4b-it` | `http://127.0.0.1:1234/v1/chat/completions` |
| `lmstudio_remote/qwen3.8-27b` | `lmstudio_remote` | `qwen3.8-27b` | `http://192.0.2.1:1234/v1/chat/completions` |
| `ollama/llama3.2` | `ollama` | `llama3.2` | `http://127.0.0.1:11434/v1/chat/completions` |
| `openrouter/anthropic/claude-sonnet-5` | `openrouter` | `anthropic/claude-sonnet-5` | `https://openrouter.ai/api/v1/chat/completions` |
| `openai/gpt-4o` | `openai` | `gpt-4o` | `https://api.openai.com/v1/chat/completions` |

---

## 5. 各言語からの接続実装サンプルコード

### ① TypeScript / JavaScript (ブラウザ / Node.js)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8765/v1',
  apiKey: 'your-gateway-client-token', // client_auth: false の場合は任意の文字列でOK
  dangerouslyAllowBrowser: true,
});

// 1. ローカル LM Studio のロード中モデルで推論
const resLM = await client.chat.completions.create({
  model: 'lmstudio/default',
  messages: [{ role: 'user', content: 'バリエーションツリー分析（VTA）とは何ですか？' }],
});
console.log('LM Studio:', resLM.choices[0].message.content);

// 2. ローカル Ollama でストリーミング推論
const streamOllama = await client.chat.completions.create({
  model: 'ollama/llama3.2',
  messages: [{ role: 'user', content: '安全工学におけるヒューマンエラー要因を3つ挙げて。' }],
  stream: true,
});
for await (const chunk of streamOllama) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

### ② Python (OpenAI SDK / LangChain)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8765/v1",
    api_key="your-gateway-client-token",
)

# Tailscale 経由のリモート PC 上の LM Studio を呼び出し
response = client.chat.completions.create(
    model="lmstudio_remote/qwen3.8-27b",
    messages=[
        {"role": "user", "content": "ヒューマンエラー防止のためのブレイクと排除ノードの違いを説明してください。"}
    ],
    temperature=0.3,
)

print(response.choices[0].message.content)
```

---

## 6. 設定ファイル (`gateway.json`) 詳細リファレンス

### 全項目定義一覧

```jsonc
{
  // 1. バインド先ネットワーク設定
  "listen": {
    "address": "127.0.0.1",     // セキュリティ上 "127.0.0.1" または "::1" のみ許可
    "port": 8765                 // リッスンするポート番号
  },

  // 2. クライアント認証設定
  "security": {
    "client_auth": false,        // クライアント認証を有効化するか (ローカル専用なら false 推奨)
    "credential_name": "llm_gateway|default"
  },

  // 3. OS資格情報ストア連携
  "credentials": {
    "service_name": "CloudLLM",  // 資格情報ストアのサービス名（既定: CloudLLM）
    "environment_fallback": false // 資格情報が見つからない場合に環境変数をフォールバック探索するか
  },

  // 4. プロキシ・タイムアウト制御
  "proxy": {
    "max_request_body_mb": 64,   // 最大リクエストボディサイズ (MB)
    "connect_timeout_sec": 10,   // 上流接続タイムアウト (秒)
    "read_timeout_sec": 600,     // 上流読み込み（推論待機）タイムアウト (秒)
    "write_timeout_sec": 600     // 上流書き込みタイムアウト (秒)
  },

  // 5. モデルディスカバリのキャッシュ
  "model_cache": {
    "enabled": true,             // /v1/models の応答をキャッシュするか
    "ttl_sec": 60                // キャッシュ有効期間 (秒)
  },

  // 6. CORS (Cross-Origin Resource Sharing)
  "cors": {
    "enabled": true,
    "allowed_origins": [         // 許可するオリジン（完全一致、末尾スラッシュなし）
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:3000"
    ],
    "allowed_methods": ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    "allowed_headers": ["Authorization", "Content-Type"],
    "max_age_sec": 600
  },

  // 7. プロバイダ定義 (複数定義可能)
  "providers": {
    // ローカル LLM (LM Studio)
    "lmstudio": {
      "base_url": "http://127.0.0.1:1234/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "lmstudio/*" }]
    },

    // Tailscale 経由のリモート LM Studio
    "lmstudio_remote": {
      "base_url": "http://192.0.2.1:1234/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "lmstudio_remote/*" }]
    },

    // ローカル LLM (Ollama)
    "ollama": {
      "base_url": "http://127.0.0.1:11434/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "ollama/*" }]
    },

    // クラウド LLM (OpenRouter)
    "openrouter": {
      "base_url": "https://openrouter.ai/api",
      "authentication": "bearer",
      "key_vendor": "openrouter",
      "key_slot": "default",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "openrouter/*" }]
    }
  },

  // 8. ロギング
  "logging": {
    "level": "info",             // "debug", "info", "warn", "error"
    "file": "llm-gateway.log"    // ログ出力先ファイル
  }
}
```

---

## 7. エラーコード一覧 ＆ トラブルシューティング

| HTTP Status | エラー識別子 (error.type) | 原因 | 対処法 |
| :---: | :--- | :--- | :--- |
| **400** | `gateway_invalid_request` / `gateway_invalid_model` | リクエストJSONが不正、または `model` が `<provider>/<model>` 形式でない | リクエストボディとモデル指定を確認してください。 |
| **401** | `gateway_authentication_error` | Client Token の不一致、または未指定 | `Authorization: Bearer <Gateway Token>` が資格情報マネージャーの登録値と一致しているか確認してください。 |
| **403** | `gateway_model_forbidden` | 指定されたモデルが `allowlist` に含まれていない（Default Deny） | `gateway.json` の `allowlist` に対象モデル（または `lmstudio/*` 等のglobパターン）を追加してください。 |
| **404** | `gateway_provider_not_found` | モデル名に指定されたプロバイダが `providers` に定義されていない | `gateway.json` の `providers` 設定を確認してください。 |
| **413** | `gateway_payload_too_large` | リクエストサイズが `max_request_body_mb` を超過 | `proxy.max_request_body_mb` の値を引き上げてください。 |
| **502** | `gateway_upstream_error` | LM StudioやOllama、クラウドプロバイダとの通信失敗 | LM Studio/Ollamaが起動しているか、ポート番号（1234/11434）やIPアドレスが正しいか確認してください。 |
| **503** | `gateway_credential_error` | OS資格情報ストアからAPIキーが見つからない（クラウド利用時） | `llm-gateway-credential-manager.exe` で対象プロバイダのキーが登録されているか確認してください。 |
| **504** | `gateway_upstream_error` (timeout) | 上流プロバイダの応答がタイムアウトした | `proxy.read_timeout_sec` を延長してください。 |
