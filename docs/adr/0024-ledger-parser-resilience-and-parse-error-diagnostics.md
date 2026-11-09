# ADR-0024: 台帳パーサーの構文耐性・自己治癒とパース失敗時診断トレーサビリティの強化

- **ステータス**: Accepted
- **決定日**: 2026-11-08
- **対象コンポーネント**: VTA Ledger Engine (`eventLedger.ts`, `fulltextLedger.ts`), Diagnostics (`aiDiagnostics.ts`), Prompts (`eventPrompts.ts`, `public/prompts.json`)
- **関連要件 / ADR**: [ADR-0009](file:///docs/adr/0009-structured-ai-diagnostics-and-log-cost-optimization.md), [ADR-0015](file:///docs/adr/0015-llm-streaming-retry-and-prompt-architecture.md), [ADR-0023](file:///docs/adr/0023-ledger-prompt-disambiguation-and-preliminary-downgrade.md)

## 1. コンテキストと課題 (Context & Problem Statement)

長大報告書（羽田空港C滑走路事故、28,530文字 / 69イベント）の正規化実行トレース（`2026-11-08T11:39:55.792Z`）において、`Stage 1a（全文正規化）` の末尾（119行目）で次のエラーが発生し、処理が中断した：

```
台帳 119行目のIDが不正です。タブ区切りで出力してください。
```

原因を分析した結果、以下の構造的課題が判明した：

1. **`parseLedger` の過度に厳格なID検証と単一行エラーによる全体破棄**:
   - `[帰結]` や `[整理]`、`[共有カード]`、`[表記]`、`[表現]` など、下流のイベントやリレーションから外部キーとして参照されない終端セクションにおいて、LLM が先頭の `ID` 列を省略（例: `[帰結]` で `identified\tE68\tp15\t機能喪失` の4列出力）したり、プレースホルダや数字（`1`, `-`）をIDに記入した場合に、`validId(cells[0])` が即座に例外を投げていた。
   - `parseLedger` の例外により、直前に抽出されていた **118行に及ぶ正常なイベント・主体・関係・帰結データがすべて破棄** され、行単位の自動修復ループ（`ledgerRepairInput`）にも入れずパイプラインが即座にクラッシュしていた。
2. **セル内改行による意図しない行分割**:
   - `内容` や `理由` セル内に改行が混入した際、行が2つに分割され、後続行の先頭テキストが日本語になって `validId` を落としていた。
3. **診断パッケージでのパースエラー情報欠落**:
   - `parseLedger` が `inspectLedger` より前に失敗するため、`ledger.validation` のデバッグログが記録されず、119行目に LLM が実際に出力したテキスト内容が診断パッケージ（`aiDiagnostics`）で把握できなかった。
4. **プロンプトにおける `[帰結]` 記入例の欠落**:
   - `SECTION_ORDER_POLICY` では `[帰結]` にヘッダ行のみがありデータ行の例（`out_1\tidentified\tE_loss\tp1\t主機能喪失`）が欠けていたため、LLM がID列の存在を見落としやすかった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **抽出済み台帳データの最大保全**: 100行以上の正常な抽出結果を軽微な構文不整合（末尾セクションのID省略や記号）で全破棄せず、安全に自己治癒して下流の構造バリデーション（`inspectLedger`）へ引き渡す。
- **事実性と関係整合性の完全遵守**: `[イベント]` や `[主体]`、`[関係]` など他の行からID参照されるエンティティのIDを勝手に改変・捏造しない（参照されない終端セクションのみを安全に自動採番）。
- **完全なトレーサビリティ**: パース失敗が発生した場合でも、該当行および前後行の生テキストをAI診断パッケージに抽出し、原因を即座に特定できるようにする。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: プロンプトの例示追加のみ**
  - プロンプトに従わないケースが一定確率で残り、1行の構文ミスで全台帳が破棄される根本リスクが解消しない。
- **選択肢2: `parseLedger` のバリデーション全廃**
  - 不正なデータが下流に流入し、予期せぬクラッシュや型不整合を引き起こす。
- **選択肢3: 非参照セクションの自動採番・セル内改行結合・パースエラー診断記録（採用）**
  - 外部キー参照されないセクションのID省略（`identified\t...` や `-\t...`）を決定論的ID（`out_n`, `D_n`, `G_n`）で補完し、セル内改行の自動結合やスペース区切りフォールバックを実装。さらにパースエラー時の生行テキスト記録を追加。

## 4. 決定事項 (Decision Outcome)

1. **`parseLedger` の構文耐性と自己治癒強化 (`eventLedger.ts`)**:
   - **非参照セクション（`帰結`, `共有カード`, `整理`, `表記`, `表現`）のID補完**:
     - `[帰結]` で先頭が判定ステータス（`identified` 等）で4列の場合は `out_n` を先頭に付与。
     - `[共有カード]` で2列の場合は `G_n` を先頭に付与。
     - 第1列が `-` や数字（`1` 等）の場合は `D_1`, `out_n` 等の正準プレフィックス付きIDへ正規化。
   - **セル内改行の自動結合**:
     - 直前行が同セクションかつ規定列数未満で、現在行の先頭が有効なIDでない場合、直前行の末尾セルに現在行を結合。
   - **マークダウン・スペース区切りフォールバック**:
     - タブが含まれず2連続以上のスペースで区切られている場合や、マークダウン表区切り（`|`）がある場合を透過的にパース。
   - **詳細なエラーメッセージ**:
     - 万一ID不正で停止する場合、`セクション名` と `先頭セルの実文字列` をエラー文に含め、即時診断を可能にする。
2. **パース失敗時の診断ログ記録とエンティティ誤帰属防止 (`fulltextLedger.ts`, `aiDiagnostics.ts`)**:
   - `fulltextLedger.ts` で `parseLedger` が失敗した際に `ledger.parse_error` をデバッグレコーダーに記録し、未パースの元テキストとエラーメッセージを保持。
   - `buildAIDiagnostics` でパースエラー発生行の前後2行を抜粋し、`anomalies` に `LEDGER_PARSE_ERROR` として記録。また、構文パースエラーや通信エラー時には `trigger_entity_id` に無関係なエンティティIDを帰属させないよう防御。
3. **プロンプトの `[帰結]` 例行追加 (`eventPrompts.ts`, `public/prompts.json`)**:
   - `SECTION_ORDER_POLICY` に `[帰結]` の具体例行（`out_1\tidentified\tE_loss\tp1\t主機能喪失`）を追加。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - LLM が `[帰結]` や `[整理]` で先頭IDを省略したり数字や `-` を出力しても例外で落ちず、100行規模の抽出結果が確実に保持される。
  - セル内改行やスペース区切りによるパース失敗が自己治癒される。
  - 万一パース失敗した場合も、AI診断パッケージで問題の行番号・セクション・生テキストが一目瞭然となる。
- **トレードオフ・考慮事項**:
  - `帰結` や `整理` のIDが省略された場合に `out_1`, `D_1` 等の自動採番が行われるが、これらのIDは他のセクションから参照されないため下流への副作用はない。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/services/generation/fulltextLedger.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `public/prompts.json`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
