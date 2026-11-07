# ADR-0018: TPDD LLM通信層の共通部品化・指数バックオフ自動リトライおよびSSEストリーミング既定化 (TPDD LLM Gateway Retry, Shared Transport, and Stream Default)

- **ステータス**: Accepted
- **決定日**: 2026-11-07
- **対象コンポーネント**: Shared LLM Utilities (`src/shared/llm/`), TPDD Gateway Client (`src/tools/tpdd/services/llm/`), TPDD Domain (`commands.ts`), VTA LLM Client (`src/tools/vta/services/llm/client.ts`)
- **関連要件 / ADR**: ADR-0015

---

## 1. コンテキストと課題 (Context & Problem Statement)

TPDD-Editor のアーキテクチャおよびプロンプトの点検において、LLM 通信層に以下の課題が確認された。

1. **一時的障害に対するリトライの不在と `stream: false` 既定による HTTP 504 リスク**:
   - TPDD の `gatewayClient.complete` には再試行（リトライ）処理がなく、上流プロバイダーの一時的な HTTP 429 / 502 / 503 / 504 エラーや瞬断で即座に失敗していた。
   - また、新規プロジェクト作成時（`createNewProject`）の `aiPreferences.stream` の初期値が `false` であったため、推論時間の長いモデルや大規模図レビュー・要求レポート生成時に Gateway の読み取りタイムアウト（HTTP 504）が発生しやすい状態にあった（一方、設定画面 `GatewayConfigModal` の初期状態は `true` であり不整合も生じていた）。
2. **VTA と TPDD 間の通信部品の重複と逆方向参照**:
   - VTA の `client.ts` が TPDD 内部の `src/tools/tpdd/services/llm/sseParser.ts` を直接インポートしており、ツール間の境界が曖昧になっていた。
   - `Retry-After` ヘッダ解析や指数バックオフ待機のロジックが VTA 内に閉じ込められており、TPDD から再利用できない構造であった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **責務に応じた適切な共有境界**: VTA の `callLLMGateway`（監査トレース・`debugRecorder` 連携）と TPDD の `gatewayClient`（軽量なサービスインターフェース・ストリーミング文字数コールバック）は上位の責務が異なるためクライアント自体は無理に単一化せず、純粋な通信部品（SSE パーサー・リトライ制御）のみを `src/shared/llm/` に切り出すこと。
- **既存テストとの互換性と本番コードの純粋性**: 本番コード内にテスト環境判定分岐を入れず、`LlmCallOptions.maxRetries` の注入によって制御すること（単体呼び出しの既定値は `0` とし、UI 実行箇所から `maxRetries: 2` を指定する）。
- **安全なリトライ対象の選別**: 401/403/400/413、ユーザーによるキャンセル（`AbortError`）、クライアント側タイムアウト（最大600秒）、および出力長超過（`finish_reason: length`）は再試行しても解決しない、あるいは長時間の待機を強いるためリトライ対象外とすること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1: VTA と TPDD の LLM クライアントを完全に1つのクラス/関数へ統合する**:
  - *却下理由*: VTA 固有の Zustand ストアログや `debugRecorder`、エラーメッセージ規約と TPDD 固有の `GatewayError` 規約が密結合になり、双方の保守性を損なう。
- **選択肢 2: `src/shared/llm/` に `sseParser.ts` と `retry.ts` を切り出して共有し、TPDD の `gatewayClient` にリトライ導入と `stream: true` 既定化を行う（採用）**:
  - ツール間の依存方向を `tools/* -> shared/*` に正規化しつつ、最小の変更で TPDD の耐障害性を引き上げられる。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 共通通信部品の切り出し (`src/shared/llm/`)
1. `src/shared/llm/sseParser.ts` に `parseSseStream` を配置し、VTA と TPDD の双方から参照する。
2. `src/shared/llm/retry.ts` に `RETRYABLE_HTTP_STATUS_CODES`、`parseRetryAfterMs`、`isRetryableGatewayError`、`computeRetryDelayMs`、`waitForRetryBackoff` を配置する。

### 4.2 TPDD `gatewayClient` への自動リトライ導入 (`gatewayClient.ts`, `types.ts`)
1. `LlmCallOptions` に `maxRetries?: number`、`retryBaseDelayMs?: number`、`onRetry?: (attempt: number) => void` を追加する。
2. HTTP 408 / 429 / 500 / 502 / 503 / 504 およびネットワーク層エラー（`statusCode === 0`）に限り、ジッター付き指数バックオフ（`Retry-After` ヘッダ優先）で再試行する。
3. 再試行時には `onRetry` コールバックを呼び出し、`AiPanel` 側の受信文字数カウンタ（`streamChars`）をリセットする。

### 4.3 新規プロジェクトの `stream: true` 既定化 (`commands.ts`)
1. `createNewProject` の `aiPreferences.stream` 初期値を `true` に変更する（既存保存済みプロジェクトの設定値は変更しない）。

---

## 5. 結果と影響 (Consequences)

### メリット
- **HTTP 504 タイムアウトと一時障害の大幅低減**: SSE ストリーミング既定化により Gateway のアイドル切断を防ぎ、一時的な 429/502/503/504 からも自動回復できる。
- **モジュール境界の健全化**: `tools/vta` から `tools/tpdd` への直接参照が解消され、`src/shared/llm/` に共通基盤が集約された。

### トレードオフ・考慮事項
- ストリーミング非対応の特殊なローカル LLM 構成を使用する場合は、TPDD の Gateway 設定モーダルから「ストリーミング受信を使用」のチェックを外すことで従来どおり非ストリーミング通信に切り替え可能である。

### 影響ファイル
- `src/shared/llm/sseParser.ts`
- `src/shared/llm/retry.ts`
- `src/tools/tpdd/services/llm/types.ts`
- `src/tools/tpdd/services/llm/gatewayClient.ts`
- `src/tools/tpdd/domain/commands.ts`
- `src/tools/vta/services/llm/client.ts`
- `tests/tpdd/services/sseParser.test.ts`
- `tests/tpdd/services/gatewayClient.test.ts`
- `tests/tpdd/app/projectLifecycle.test.ts`
