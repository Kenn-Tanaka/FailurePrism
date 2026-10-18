# Lightweight LLM Gateway 1.3.2 クイックスタート

## 1. 設定（gateway.json）

クラウドLLM（OpenRouter等）とローカルLLM（LM Studio, Ollama等）を同時に設定できます。

```json
{
  "listen": { "address": "127.0.0.1", "port": 8765 },
  "security": { "client_auth": false, "credential_name": "llm_gateway|default" },
  "credentials": { "service_name": "CloudLLM", "environment_fallback": false },
  "proxy": { "max_request_body_mb": 64, "connect_timeout_sec": 10, "read_timeout_sec": 600, "write_timeout_sec": 600 },
  "model_cache": { "enabled": true, "ttl_sec": 60 },
  "cors": {
    "enabled": true,
    "allowed_origins": ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:3000", "http://localhost:3000"],
    "allowed_methods": ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    "allowed_headers": ["Authorization", "Content-Type"],
    "max_age_sec": 600
  },
  "providers": {
    // ローカル PC の LM Studio
    "lmstudio": {
      "base_url": "http://127.0.0.1:1234/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "lmstudio/*" }]
    },
    // Tailscale 経由のリモート PC の LM Studio
    "lmstudio_remote": {
      "base_url": "http://192.0.2.1:1234/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "lmstudio_remote/*" }]
    },
    // ローカル PC の Ollama
    "ollama": {
      "base_url": "http://127.0.0.1:11434/v1",
      "authentication": "none",
      "model_discovery": true,
      "allowlist": [{ "type": "glob", "pattern": "ollama/*" }]
    },
    // クラウド OpenRouter (利用する場合)
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

## 2. 資格情報の登録（クラウドAPIを利用する場合のみ）

ローカルLLMのみ利用する場合は不要です。クラウド利用時は `llm-gateway-credential-manager.exe` または Python `keyring` で登録します。

```python
import keyring
keyring.set_password("CloudLLM", "llm_gateway|default", "gateway-token")
keyring.set_password("CloudLLM", "openrouter|default", "sk-or-v1-xxxxxx")
```

---

## 3. Gatewayの起動

```powershell
.\llm-gateway.exe .\gateway.json
```

---

## 4. 疎通テスト (cURL)

### ① 利用可能モデル一覧の取得（LM Studio, Ollama, クラウド統合）
```powershell
curl.exe http://127.0.0.1:8765/v1/models
```

### ② ローカル LM Studio での推論テスト
- **ロード中モデルの直接実行**:
  ```powershell
  curl.exe http://127.0.0.1:8765/v1/chat/completions `
    -H "Content-Type: application/json" `
    -d '{"model":"lmstudio/default","messages":[{"role":"user","content":"こんにちは"}],"stream":true}'
  ```
- **指定モデルのJITロード実行**:
  ```powershell
  curl.exe http://127.0.0.1:8765/v1/chat/completions `
    -H "Content-Type: application/json" `
    -d '{"model":"lmstudio/qwen2.5-7b-instruct","messages":[{"role":"user","content":"こんにちは"}],"stream":true}'
  ```

### ③ Tailscale経由 リモート LM Studio での推論テスト
```powershell
curl.exe http://127.0.0.1:8765/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{"model":"lmstudio_remote/default","messages":[{"role":"user","content":"こんにちは"}],"stream":true}'
```

### ④ ローカル Ollama での推論テスト
```powershell
curl.exe http://127.0.0.1:8765/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{"model":"ollama/llama3.2","messages":[{"role":"user","content":"こんにちは"}],"stream":true}'
```

---

## 5. 主なエラーと対処

| Status | 内容 | 対処法 |
|:---:|---|---|
| **400** | Request・Model ID形式不正 | `provider/model` 形式（例: `lmstudio/default`）で指定してください。 |
| **401** | Client Token不一致 | `client_auth: true` の場合、認証ヘッダーを正しく付与してください。 |
| **403** | allowlist拒否 (Default Deny) | `gateway.json` の `allowlist` に `lmstudio/*` などのパターンを追加してください。 |
| **502** | 上流通信失敗 | LM Studio / Ollama が起動しているか、ポート番号やIPを確認してください。 |
| **503** | 資格情報未設定 | クラウド利用時は `llm-gateway-credential-manager.exe` でAPIキーを登録してください。 |
| **504** | 上流タイムアウト | `proxy.read_timeout_sec` を延長してください。 |
