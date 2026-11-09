# ADR-0023: 台帳プロンプトにおける未割当主体・仮判定書式の明確化と仮判定格下げ・ポリシーブロック置換の是正

- **ステータス**: Accepted
- **決定日**: 2026-11-08
- **対象コンポーネント**: VTA LLM Prompts (`eventPrompts.ts`, `contextEvidencePolicy.ts`, `public/prompts.json`) / Ledger Validation (`eventLedger.ts`) / AI Diagnostics (`aiDiagnostics.ts`)
- **関連要件 / ADR**: [ADR-0001](file:///docs/adr/0001-two-stage-event-classification-and-batch-adoption.md), [ADR-0009](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md), [ADR-0015](file:///docs/adr/0015-llm-streaming-retry-and-prompt-architecture.md), [ADR-0016](file:///docs/adr/0016-preliminary-classification-pipeline-separation.md)

## 1. コンテキストと課題 (Context & Problem Statement)

長大事故調査報告書（羽田空港C滑走路衝突事故、28,530文字 / 69イベント）を `refined-chain` 方式で実行した診断トレース（`2026-11-08T11:11:49.911Z`）において、初回台帳検証（`ledger.validation`）で61件のバリデーションエラーが発生し、16,914文字の台帳修復往復（1回）が発生した。また、後続の通信フェーズで発生した HTTP 504 タイムアウト（`upstream_timeout`）が、診断パッケージ上で初回台帳修復対象の先頭エンティティ `E1` に誤帰属されていた。

原因を分析した結果、以下の4点が特定された：

1. **ポリシーブロック置換における前方一致サブストリング問題（`upsertPolicyBlock`）**:
   - `AUDIT_SECTIONS_WITHOUT_PRELIMINARY_POLICY` は `AUDIT_SECTIONS_POLICY` の完全な先頭部分文字列（prefix substring）であるため、`upsertPolicyBlock` の先頭にあった `if (systemPrompt.includes(trimmedBlock))` が真となり、`omitPreliminary: true` を指定しても既存の `[仮判定]` セクション指示が削除されずにシステムプロンプトへ残存していた。
2. **未割当イベントの「主体と役割」列書式の未明記**:
   - プロンプト上で「引き継げない場合は未割当で保持する」と指示していたが、例示行が `A1:actor` の1行しかなく、LLM が自然災害等の主体未割当イベント（`E1`、`E43`）に対して `-:actor` と出力し、パーサが未定義主体 `'-'` として拒否していた。
3. **`[仮判定]` における `normal\t-\t-` の大量出力とハードエラー化**:
   - `normal` / `variation` に理由と原文参照が必須であることは記載されていたが記入例がなく、LLM が59件の行を `normal\t-\t-` で出力した。パーサのエラー文自体は「根拠がなければ undetermined とします」と述べているにもかかわらず、実装は例外を送出して台帳修復往復を発生させていた。
4. **通信エラー時のトリガーエンティティ誤帰属**:
   - `buildAIDiagnostics` が `failurePhase === '通信'`（HTTP 504 等）のトランスポート障害時にも過去の `anomalies` からエンティティID（`E1`）を抽出し、`trigger_entity_id` に設定していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **初回正規化の成功率向上と不要な修復往復の排除**: 書式曖昧性に起因する1.7万文字規模の修復リクエストを防ぎ、レイテンシとトークン消費を削減する。
- **事実性（Factuality）の厳格保持**: 未割当主体の自己治癒や仮判定の格下げにおいて、原文にない主体や根拠を一切捏造しない。
- **可観測性の維持**: 決定論的バックストップ（自己治癒・格下げ）が発動した際は警告ログ（`[台帳記録警告]`）と診断パッケージの `anomalies`（`LEDGER_WARNING`）に記録し、プロンプト遵守状況を追跡可能にする。
- **途中再開キャッシュの整合性**: `EVENT_PIPELINE_PROMPT_VERSION` を更新し、旧プロンプトのキャッシュ（`pendingLedgers`）と混在しないようにする。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: プロンプト文言の改訂のみ行う**
  - `upsertPolicyBlock` とプロンプト文言を修正するだけで大半は解消するが、LLM が1行でも `-:actor` や `normal\t-\t-` を出力した場合に依然として全文規模の台帳修復往復が発生する。
- **選択肢2: パーサの寛容化のみ行う**
  - 修復往復は減るが、`omitPreliminary: true` 時の `[仮判定]` 混入バグやプロンプト上の書式曖昧性が放置され、不要な出力トークン生成が続く。
- **選択肢3: `upsertPolicyBlock` の範囲置換修正 ＋ プロンプト書式明記（`event-ledger-15`） ＋ 決定論的バックストップ（警告付き自己治癒・格下げ）の組み合わせ（採用）**
  - 根本原因であるプロンプト合成バグと書式指示を正したうえで、万一の書式逸脱も事実性を損なわず非停止で吸収し、警告として診断パッケージに残す。

## 4. 決定事項 (Decision Outcome)

1. **`upsertPolicyBlock` の境界優先置換への修正（P3）**:
   - `headerPrefix` の開始位置 `startIdx` と次セクション境界 `endIdx` を先に特定し、既存ブロック `systemPrompt.slice(startIdx, endIdx).trim()` が `canonicalBlock.trim()` と完全一致しない限り確実に置換するよう修正した。これにより `omitPreliminary: true` 時に `[仮判定]` が確実に除去される。
2. **未割当主体と仮判定の書式・記入例の明記および版数更新（P1, P2, P4）**:
   - `SECTION_ORDER_POLICY`、`SECTION_ORDER_ANCHOR_FIRST_POLICY`、`EXTRACTION_ANCHORING_POLICY`、`SUBJECT_INFERENCE_POLICY` に「主体が特定できないイベントは『主体と役割』列を半角 `-` 1文字のみにする（`-:actor`、`-:役割`、空欄、『不明』は不可）」と未割当イベントの例行を追加した。
   - `AUDIT_SECTIONS_POLICY` と `PRELIMINARY_CLASSIFICATION_PROMPT` に `normal` / `undetermined` の対比例行（`E_x1` / `E_x2`）と「理由・参照のどちらかを書けない行は判定そのものを `undetermined` にする（`normal\t-\t-` は不可）」を明記した。
   - `EVENT_PIPELINE_PROMPT_VERSION` を `'event-ledger-15'` に更新し、`public/prompts.json` と同期した（版数変更により旧版数の `pendingLedgers` キャッシュは自動的に無効化される）。
3. **決定論的バックストップ（P5）**:
   - `eventLedger.ts` の `[イベント]` 解析にて、`-:actor` や `-:target:inferred` のように主体ID部が `-` かつ有効な役割名を持つトークンを未割当（`-`）として正規化し、警告を記録する。
   - `inspectLedger` および `inspectPreliminaryClassifications` の `[仮判定]` 解析にて、`normal` / `variation` で理由または原文参照が欠落している行を例外とせず `undetermined` へ格下げし、警告を記録する（イベント範囲外の参照段落や存在しないイベントIDは従来通りエラーとして検出する）。
4. **診断パッケージ（`aiDiagnostics.ts`）の改善**:
   - `ledger.validation` の `warnings` を `LEDGER_WARNING` として `anomalies` に記録しつつ、通信層エラー（HTTP 5xx / タイムアウト等）や `LEDGER_WARNING` から `trigger_entity_id` を誤帰属させないようにした。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `refined-chain` 実行時に Stage 1a で不要な `[仮判定]` が出力されなくなり、出力トークン数とレイテンシが大幅に削減される。
  - `-:actor` や理由欠落の `[仮判定]` による1.7万文字規模の修復往復がゼロになり、パイプラインの安定性と速度が向上する。
- **トレードオフ・考慮事項**:
  - `EVENT_PIPELINE_PROMPT_VERSION` を `event-ledger-15` に更新したため、同一セッション内で旧版数で途中失敗していた `pendingLedgers` キャッシュからは再開せず新規取得となる（保存済みプロジェクトデータへの影響はない）。
- **影響ファイル**:
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `src/tools/vta/services/llm/contextEvidencePolicy.ts`
  - `public/prompts.json`
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/services/llm/prompts.test.ts`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
