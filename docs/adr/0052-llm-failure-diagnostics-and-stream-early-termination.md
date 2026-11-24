# ADR-0052: LLM 失敗時の出力・推論トークン診断可視化および終端マーカーによる SSE ストリーム早期終了ポリシー

- **Status**: `Accepted`
- **Date**: `2026-11-19`
- **Target Components**:
  - `src/shared/llm/sseParser.ts` (`SseDeltaChunk`, `parseSseStream`)
  - `src/tools/vta/services/llm/client.ts` (`callLLMGateway`, `findCompleteTerminatorEnd`, `callLedgerStage`)
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts` (`buildAIDiagnostics`)
- **Related Requirements / ADRs**:
  - [ADR-0015](./0015-llm-streaming-retry-and-prompt-architecture.md)
  - [ADR-0027](./0027-relation-id-disambiguation-and-stream-progress-observability.md)
  - [ADR-0047](./0047-reoptimize-layout-monotonicity-and-vertical-stub-exemption.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

長大な事故調査報告書（約 2.8 万文字）を Claude Sonnet 系モデルで解析した際、1 回の通信で 65,536 トークン（約 413 秒）を消費して `finish_reason: "length"` により失敗する事象が発生した。この調査において以下の 2 つの構造的課題が明らかになった。

1. **失敗時の観測情報不足（原因の切り分け不能）**:
   - `sseParser.ts` は `delta.content` のみを読み、`delta.reasoning` / `delta.reasoning_content`（思考・推論デルタ）を破棄していた。
   - `client.ts` の `llm.failure` デバッグ記録および `aiDiagnostics.ts` の遷移ノートには `finishReason`、`contentLength`、`contentTail`、`reasoningLength` が含まれておらず、「`[完了]` 出力後に本文が暴走した（仮説 A）」のか「推論トークンが出力枠を消費した（仮説 B）」のかを診断ログから判別できなかった。
2. **台帳系ストリームの `[完了]` 後の受信継続**:
   - `[完了]` を終端契約とする台帳ステージ（`callLedgerStage`）で、モデルが単独行の `[完了]` を出力した後に余剰テキストや反復ループを続けた場合、クライアントがストリームを早期終了せずにサーバー切断まで待ち続け、課金・待機時間の浪費および `finish_reason: "length"` 誘発につながるリスクがあった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **未完成出力の厳格拒否ポリシーの維持**: `finish_reason === 'length'` で打ち切られた出力を安易に救済採用しない（「途中の結果は採用しません」、`eventPipeline.test.ts` L138 の契約維持）。
- **API `stop` パラメータの副作用回避**: OpenAI / OpenRouter 互換 API の `stop` シーケンスは一致文字列が出力から除去されるため、`[完了]` 必須パーサ（`parseLedger`）と衝突するリスクを避け、クライアント側のストリーム監視で安全に制御する。
- **文中語句の誤検知防止**: 本文中に「作業[完了]確認」のように `[完了]` が含まれるケースで誤ってストリームを切断しないこと。

## 3. 検討した選択肢 (Considered Options)

1. **Option A: 失敗診断メトリクス拡張（推論デルタ計測含む）＋ 単独行終端マーカーによる SSE 早期終了（採用）**
   - `parseSseStream` で `reasoning` デルタを optional 抽出し、`llm.failure` および AI 診断ノートに `finishReason` / `contentLength` / `reasoningLength` / `contentTail` を出力する。
   - `callLLMGateway` に opt-in の `options.terminator` を追加し、`callLedgerStage` で `'[完了]'` を指定。単独行 `[完了]` の直後に改行が到着した時点で `controller.abort()` して早期完了させ、後続の余剰トークンを切り落とす。`finish_reason === 'length'` の拒否ポリシーは変更しない。
2. **Option B: API リクエストに `stop: ['\n[完了]']` を渡す＋ `length` 時に `[完了]` までを救済採用する**
   - `stop` で `[完了]` が欠落するプロバイダ差異への対処が必要であり、`length` 時の救済採用は既存の未完成拒否契約と衝突するため不採用。
3. **Option C: 固定の `max_tokens: 8192` を設定する**
   - 実測で 65,536 トークン到達事象が発生しており、8,192 固定では根本解決にならず逆に正常な長大出力を切断する恐れがあるため不採用。

## 4. 決定事項 (Decision Outcome)

Option A を採用し、以下を実装した。

1. **推論デルタ計測と `llm.failure` 診断拡張 (`sseParser.ts`, `client.ts`, `aiDiagnostics.ts`)**:
   - `SseDeltaChunk` に `reasoning?: string` を追加し、`delta.reasoning` / `delta.reasoning_content` を計測可能にした。
   - `callLLMGateway` の `llm.failure` に `finishReason`, `contentLength`, `contentTail`（末尾最大 300 字）, `reasoningLength` を記録し、`buildAIDiagnostics` の `llm.failure` 遷移ノートに反映した。
2. **単独行終端マーカーによる SSE 早期終了 (`client.ts`)**:
   - `findCompleteTerminatorEnd(content, terminator)` により、単独行 `[完了]` に続く改行が確定した時点でのみマッチさせ、文中表記の誤検知を防止した。
   - `callLLMGateway` の SSE ループで一致時に `[完了]` までで切り詰めて `controller.abort()` し、正常完了（`finishReason = 'stop'`）として返却する。`callLedgerStage` に `{ terminator: '[完了]' }` を適用した。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 次回 `finish_reason: "length"` が発生した際、本文暴走（仮説 A）と推論トークン消費（仮説 B）を診断ログから即座に判別できる。
  - `[完了]` 後の余剰出力・反復ループをストリーム段階で遮断し、待機時間とトークン消費を抑制できる。
- **トレードオフ・考慮事項**:
  - 推論トークン消費（仮説 B）が主因と判明した場合は、次段階として OpenRouter の `reasoning` 抑制オプションやコスト上限設定の検討が必要になる。
- **影響ファイル**:
  - `src/shared/llm/sseParser.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/services/llm/eventPipeline.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
