# ADR-0060: TSV 台帳応答の頑健化（紛らわしいヘッダー・範囲外行の非致命化・台帳キャッシュ破棄・プロンプト解決の一元化）

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA Ledger Parser`, `VTA Full-text Normalization`, `VTA Classification`, `VTA LLM Client`
- **Related Requirements / ADRs**: [ADR-0016](./0016-preliminary-classification-pipeline-separation.md), [ADR-0032](./0032-resilient-event-columns-and-audit-phrase-matching.md), [ADR-0052](./0052-llm-failure-diagnostics-and-stream-early-termination.md), [ADR-0055](./0055-outcome-classification-protection-and-manual-demotion.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

LLM の TSV 応答が少しぶれるだけで、正規化・仮判定・変動判定の処理全体が失敗したり、結果が黙って失われたりする経路があった。

1. **紛らわしい列ヘッダー**：`[判定]` の列ヘッダー（`ID\t判定\t理由\t原文参照`）と `[仮判定]` の列ヘッダー（`イベントID\t…`）は、先頭のセルしか違わない。
   - `parseLedger` は、見出しでセクションを明示した後でも、別セクションの列ヘッダー行を見つけるとそちらへセクションを切り替えていた。
   - そのため仮判定の行が黙って消えたり、正規化台帳の検証が throw したりしていた。
2. **致命的な throw**：
   - `inspectLedger` は `[判定]` 行が1行でもあると例外を投げていた。
   - `inspectClassifications` は、別セクションの行や対象外のイベントIDが1行でもあると例外を投げていた。いずれも修復ループに入らず、処理全体が失敗していた。
3. **壊れた台帳のキャッシュ残留**：`pendingLedgers` は、通信に失敗した修復を再実行時にそこから再開するためのキャッシュである。しかし、毎回同じ結果になる検証エラーでも台帳を残していたため、同じ入力で再実行すると毎回同じエラーになっていた。
4. **プロンプトの二重解決**：`callLedgerStage` が `promptConfig.version === '5.0.0'` をもう一度判定していた。旧バージョンの設定だと、`captureEventPrompts` で組み立てたプロンプト（omitPreliminary / outcomeFirst / 事後活動除外 / 連鎖指示 / FACTUALITY_POLICY）が捨てられていた。また、変動判定は組み立て済みのプロンプトを経由していなかった。
5. **非ストリーム応答の終端**：SSE 応答は単独行の `[完了]` で切り詰めていたが、非ストリーム応答は切り詰めていなかった。そのため `[完了]` の後に後書きがあるとパースが失敗していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- 根拠に関するルールを維持する。範囲外・未知の参照は、推測で補完せず**警告を出して除外**する。
- 通信失敗後に修復から再開する機能（キャッシュ）は維持する。
- 正当な「見出しなし・列ヘッダーだけ」のセクション切り替えは維持する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1：明示セクションの中では、列ヘッダーによる切り替えを一律に禁止する**
  - 見出しを省略した正当な出力（`[主体]` の後に `イベント` の列ヘッダーだけが続く、など）が壊れる。
- **選択肢2：紛らわしいペア（`判定` ⇔ `仮判定`）に限って切り替えを抑止し、範囲外の行は警告を出して除外する（採用）**
- **選択肢3：例外のたびにキャッシュを全削除する**
  - 通信失敗後に修復から再開する機能が失われる。

## 4. 決定事項 (Decision Outcome)

1. **`parseLedger`**
   - `CONFUSABLE_HEADER_SECTIONS`（`判定` ⇔ `仮判定`）を定義する。
   - 明示見出しまたは `defaultSection` で決まったセクションの中では、相手側の列ヘッダーを現在のセクションのヘッダーとして読み飛ばす。それ以外の列ヘッダーでは、従来どおりセクションを切り替える。
2. **`inspectLedger`**：正規化台帳に含まれる `[判定]` 行は、警告（`warnings`）を出して除外する。throw はしない。
3. **`inspectClassifications`**
   - 別セクションの行と、対象外・未知のイベントIDの行は、警告を出して除外する。
   - 入力ドキュメントは書き換えず、応答に含まれなかったイベントを補った `normalizedDoc` を返す。
   - `classifyEventDraft` は `normalizedDoc` で修復を続け、警告をログに出す。帰結イベントの行は従来どおり黙って無視する（ADR-0055）。
4. **`normalizeSource`**：`inspectLedger` で例外が出たとき（毎回同じ結果になる検証エラー）に限り、`pendingLedgers` から台帳を削除し、`[台帳破棄]` をログに出す。修復通信の失敗時は、従来どおり台帳を保持する。
5. **`callLedgerStage`**
   - `captureEventPrompts()` で確定済みのステージ別プロンプトをそのまま使い、version は再判定しない。
   - 変動判定は、初回と修復で同じ確定済みプロンプトを使う。
   - テンプレートの置換は関数で行う（原文中の `$&` などが置換パターンとして解釈されないようにするため）。
6. **`callLLMGateway`**：非ストリーム応答にも、単独行の `[完了]` の後ろを切り詰める処理を適用する。末尾に改行のない `[完了]` も対象とする。`finish_reason: length` は従来どおり拒否する。

## 5. 結果と影響 (Consequences)

### メリット
- LLM が見出しや ID を1行誤るだけで処理全体が失敗する、あるいは結果が黙って失われる経路がなくなる。
- 同じ入力で再実行するたびに同じエラーになる状態がなくなる。
- 旧バージョンのプロンプト設定でも、実行時に組み立てる指示や事実性ポリシーが確実に適用される。

### トレードオフ・考慮事項
- 範囲外の判定行は、修復の対象にせず除外する。除外した事実は警告ログで追跡できる。
- 変動判定のときにも `captureEventPrompts` が呼ばれるため、正規化プロンプトの契約補足ログ（`[プロンプト契約]`）が出ることがある。

### 影響ファイル
- [src/tools/vta/features/vta/utils/eventLedger.ts](../../src/tools/vta/features/vta/utils/eventLedger.ts)
- [src/tools/vta/services/generation/fulltextLedger.ts](../../src/tools/vta/services/generation/fulltextLedger.ts)
- [src/tools/vta/services/llm/client.ts](../../src/tools/vta/services/llm/client.ts)
- [src/tools/vta/features/vta/utils/normalization.test.ts](../../src/tools/vta/features/vta/utils/normalization.test.ts)
- [src/tools/vta/services/generation/fulltextLedgerCache.test.ts](../../src/tools/vta/services/generation/fulltextLedgerCache.test.ts)
- [src/tools/vta/services/llm/eventPipeline.test.ts](../../src/tools/vta/services/llm/eventPipeline.test.ts)
- [docs/adr/README.md](./README.md)
