# ADR-0053: VTA SSE ストリーミングの無通信（アイドル）タイムアウト化および推論強度（`reasoning.effort`）制御ポリシー

- **Status**: `Accepted`
- **Date**: `2026-11-19`
- **Target Components**:
  - `src/tools/vta/types/vta.ts` (`LLMConfig`, `LLMReasoningEffort`)
  - `src/tools/vta/services/llm/client.ts` (`callLLMGateway`, `resolveReasoningEffort`)
  - `src/tools/vta/components/control-panel/LLMConfigSection.tsx`
- **Related Requirements / ADRs**:
  - [ADR-0015](./0015-llm-streaming-retry-and-prompt-architecture.md)
  - [ADR-0049](./0049-haia-workflow-plugin-and-model-aliases.md)
  - [ADR-0052](./0052-llm-failure-diagnostics-and-stream-early-termination.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0052 の診断拡張により、`openrouter/~anthropic/claude-sonnet-latest`（Claude Sonnet 5.5）で羽田空港事故報告書（28,530 文字）を解析した際の失敗ログから以下の事実が確認された。

1. **内部推論トークンの暴走**:
   - 180 秒経過時点で `content=0字, reasoning=25376字`（タイムアウト延長時は 413 秒で 65,536 トークンの出力上限に到達）となっており、Adaptive Thinking が本文を 1 文字も出力しないまま推論トークンを大量消費していた。
2. **Gateway・HAIA と VTA のタイムアウト仕様の不整合**:
   - リポジトリ内の C++ LLM Gateway（`gateway/src/gateway/external_proxy.cpp` L287-291, L351-357）および HAIA（`src/tools/haia/gateway.ts` L12-40, L68-74）は、SSE ストリーミング時のタイムアウトを **無通信（アイドル）タイムアウト**（チャンク受信のたびにタイマーリセット）として実装している。
   - 一方、VTA の `callLLMGateway`（`src/tools/vta/services/llm/client.ts`）のみが **リクエスト開始からの固定総時間 `setTimeout`（リセットなし）** になっており、SSE チャンクが毎秒正常に届いていても開始から 180 秒で強制切断していた。
   - また、`chunk.reasoning` 受信中は進捗ログが出力されず、UI 上で通信状況が視認できなかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **リポジトリ内 LLM Gateway 仕様への準拠**:
  - `gateway/src/gateway/http_server.cpp`（L189-233）は `POST /v1/chat/completions` の JSON ボディに対し `model` のみ書き換えて残りの全フィールドをそのまま `body_json.dump()` で上流へ透過転送する仕様であるため、トップレベルの `"reasoning": { "effort": "low" }` は Gateway を変更せずにそのまま OpenRouter へ到達する。
- **非対応モデル・プロバイダへの後方互換性**:
  - `reasoning` パラメータを受け付けず HTTP 400 を返す上流モデルに対しても、エラー終了させずに `reasoning` を除外して自動フォールバックできること。

## 3. 検討した選択肢 (Considered Options)

1. **Option A: SSE 無通信タイムアウト化 ＋ `reasoning.effort` 透過制御（HTTP 400 自動フォールバック付）＋ 推論進捗ログ（採用）**
   - `callLLMGateway` のタイムアウトタイマーをレスポンスヘッダ到着時および SSE チャンク（`content` / `reasoning` / `finishReason`）到着時にリセットする無通信タイムアウトに統一する。
   - `LLMConfig.reasoningEffort`（`'auto' | 'none' | 'minimal' | 'low' | 'medium' | 'high'`）を導入し、`'auto'`（既定）時は OpenRouter の Claude / Anthropic 系モデルに対して `reasoning: { effort: 'low' }` を付与する。HTTP 400 時は `reasoning` を外してリトライ回数を消費せず即時再試行する。
   - `chunk.reasoning` 受信中も 5 秒ごとに `本文 M文字 / 推論 N文字` の進捗ログを出力する。
2. **Option B: タイムアウトの無通信化のみ行い、`reasoning.effort` は制御しない**
   - 180 秒での切断は解消されるが、413 秒後に 65,536 トークンの出力上限に達して `finish_reason: "length"` で失敗するため不採用。

## 4. 決定事項 (Decision Outcome)

Option A を採用し、以下を実装した。

1. **SSE 無通信タイムアウトへの統一 (`client.ts`)**:
   - `resetTimeout()` / `clearActiveTimeout()` を導入し、SSE ストリーミング中に `chunk.content || chunk.reasoning || chunk.finishReason` を受信するたびにタイマーをリセットするようにし、C++ Gateway 本体および HAIA と挙動を統一した。
2. **推論強度（`reasoning.effort`）制御と HTTP 400 自動フォールバック (`vta.ts`, `client.ts`, `LLMConfigSection.tsx`)**:
   - `resolveReasoningEffort(config)` により、`reasoningEffort` が未指定または `'auto'` の場合は `openrouter/` 経由の `claude` / `anthropic` モデルに `'low'` を適用し、UI（`LLMConfigSection`）から明示変更も可能にした。
   - `reasoning` 付与時に HTTP 400 が返った場合は `omitReasoningOnRetry = true` として `reasoning` を外し、即座に再試行する。
3. **推論ストリーム中の進捗ログ可視化 (`client.ts`)**:
   - `content.length + reasoningLength` の増加を基準に 5 秒ごとの進捗ログを出力し、推論フェーズ中でも `本文 M文字 / 推論 N文字` をリアルタイム表示する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - OpenRouter 経由の Claude Sonnet で内部推論が過剰に膨らむのを抑止し、台帳本文の出力へ速やかに移行できる。
  - ストリーミングが継続しているにもかかわらず 180 秒で強制切断される問題が解消され、Gateway 本体・HAIA と一貫したタイムアウト動作になる。
- **トレードオフ・考慮事項**:
  - 深い思考が必要な個別ケースでは、左パネルの「推論強度 (Reasoning Effort)」から `medium` または `high` を明示選択できる。
- **影響ファイル**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/components/control-panel/LLMConfigSection.tsx`
  - `src/tools/vta/services/llm/eventPipeline.test.ts`
