# ADR-0016: 粒度反復方式における仮判定パイプラインの分離と段階的評価アーキテクチャ (Preliminary Classification Pipeline Separation)

- **ステータス**: Accepted
- **決定日**: 2026-11-07
- **対象コンポーネント**: Event Prompts (`eventPrompts.ts`), Event Ledger (`eventLedger.ts`), VTA LLM Client (`client.ts`), Granularity Refinement (`granularityRefinement.ts`)
- **関連要件 / ADR**: ADR-0001, ADR-0015

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港航空機衝突事故報告書（約28,500文字）などの長大インシデント文書に対する実LLMベンチマーク計測において、以下の構造的課題が確認された。

1. **多セクション同時出力による TTFT 超過と HTTP 504 タイムアウト**:
   - Stage 1（`normalizeSource`）は、長大な入力資料から「主体・イベント・関係・共有カード・整理・表記・表現・仮判定・帰結」という9セクション（計100〜200行超）を一挙に出力する契約となっている。
   - モデルが末尾の `[仮判定]`（全イベントの通常/変動/理由/原文参照）までを事前計算する過程で、Pre-fill / TTFT（初回トークン生成遅延）が35秒を超過し、OpenRouter 等の中継プロキシのアイドル制限により `HTTP 504 Gateway Timeout: Upstream provider read timed out.` が発生する直接原因となっていた。
2. **出力トークン競合によるイベント抽出打ち切り (Attention Dilution)**:
   - 全文走査と同時に全イベントの仮判定根拠を同時生成させると、モデルの注意機構（Attention）が判定推論に奪われ、時系列イベントの抽出が前半〜中盤（48件程度）で早期に打ち切られる事象が実証された。
3. **ADR-0001 事実性原則と Stage 2 最適化スコアの整合**:
   - ADR-0001 では「確定判定はユーザーの確認または明示的一括反映によってのみ行い、AI抽出段階では `unclassified` を維持する」と定めている。
   - 一方で `refined-chain`（粒度反復方式）では、Stage 2 の反復最適化における `C5` 変動カバー率スコア計算および UI 上の「仮判定一括採用」機能のために `event.preliminary`（通常・変動・保留）が必要不可欠である。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **TTFT の劇的短縮とゼロ・タイムアウトの達成**: Stage 1a から重い判定推論を分離し、構造骨格の出力開始および完了を高速化すること。
- **イベント抽出の網羅性最大化**: モデルの全計算資源を「誰が・いつ・何をしたか（事実の抽出）」に集中させ、長大文書でも網羅的なイベント抽出を実現すること。
- **ADR-0001 事実性原則の厳格な保持**: Stage 1b は `event.preliminary` のみを付与し、`event.classification` は `'unclassified'` のまま維持すること。
- **後方互換性と段階的移行**: 既存の 1パス抽出方式（`event-chain`, `fulltext-ledger`）や既存テストスイートの動作を一切壊さず、新方式（`refined-chain`）においてのみ自動適用すること。
- **障害耐性 (Graceful Degradation)**: 万が一 Stage 1b（仮判定）がタイムアウトやフォーマットエラーとなっても例外を投げず、警告ログを出力した上で未判定のまま後続の Stage 2 へ継続できること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1: 全方式で一律に `[仮判定]` を完全廃止する**:
  - *却下理由*: Stage 2 の粒度スコア $C_5$ の計算精度が失われ、ユーザーがワンクリックで初期仮判定を取り込む「仮判定の一括採用」機能が使えなくなる。
- **選択肢 2: `refined-chain` において Stage 1a（構造骨格正規化）と Stage 1b（専用仮判定パス）に分離する（採用）**:
  - Stage 1a で `[仮判定]` 出力を抑制し、骨格確定直後に確定イベント一覧と段落文脈を入力として Stage 1b を軽量に実行する。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 プロンプト合成における仮判定のオプション制御 (`eventPrompts.ts`)
1. `AUDIT_SECTIONS_WITHOUT_PRELIMINARY_POLICY` を新設し、`compileNormalizationSystemPrompt` に `omitPreliminary?: boolean` オプションを追加。`omitPreliminary: true` 指定時に `[表記]`・`[表現]` のみを要求し、`[仮判定]` をプロンプトから除外する。
2. 確定イベントから4列TSV（`イベントID \t 判定 \t 理由 \t 原文参照`）のみを出力させる `PRELIMINARY_CLASSIFICATION_PROMPT` および `compilePreliminaryClassificationSystemPrompt` を定義。

### 4.2 台帳ユーティリティの純粋関数実装 (`eventLedger.ts`)
1. `preliminaryClassificationInput(events, source)`:
   - 確定イベント一覧（ID、時刻、見出し、内容、原文参照）および参照先段落のテキストを整形したプロンプト入力テキストを生成する。
2. `inspectPreliminaryClassifications(doc, events, source)`:
   - 受信した TSV の `[仮判定]` 行をパースし、各イベントの `preliminary: { value, reason, sourceRefs }` を設定する。
   - ADR-0001 準拠: `event.classification` は `'unclassified'` を厳格に保持する。

### 4.3 Stage 1b サービス関数とパイプライン統合 (`client.ts`)
1. `populatePreliminaryClassifications(config, analysis, source, signal)`:
   - 確定イベント群を 60件単位のチャンクに分割し、`callLLMGateway` を呼び出して `preliminary` を付与。
   - ネットワークエラー・タイムアウト・パースエラー発生時も例外をスローせず、`logTrace('warn', ...)` を出力して安全にフォールバック（元の `analysis` を返却）。
2. `extractEventDraft` の実行フロー制御:
   - `schemeId === 'refined-chain'` の場合、`fixedPrompts.normalization` に `omitPreliminary: true` を指定して Stage 1a を実行。
   - Stage 1a 完了後、イベントに `preliminary` が未設定であれば自動的に `populatePreliminaryClassifications` を実行して結合し、Stage 2（`refineGranularity`）へ渡す。

---

## 5. 結果と影響 (Consequences)

### メリット
- **TTFT の短縮と HTTP 504 の抑止**: Stage 1a の出力行数が大幅に減り、モデルの Pre-fill / TTFT が大幅に短縮され、上流プロキシでのタイムアウトが抑止される。
- **イベント抽出密度の向上**: モデルが判定理由の記述に引きずられることなく、全文からの網羅的なイベント抽出に注力できる。
- **後方互換性と堅牢性**: 既存の `event-chain` / `fulltext-ledger` 方式や単体テストは従来どおり 1パスで稼働し、`refined-chain` においても Stage 1b の失敗が全体のクラッシュを引き起こさない。

### トレードオフ・考慮事項
- **API 呼び出し回数**: `refined-chain` において LLM 呼び出しが 1 回（長大な場合はチャンク数分）増加する。ただし、Stage 1b の入力は確定イベントと参照段落のみ、出力も4列TSVのみであるため、所要時間は短くトークン消費も局所的である。

### 影響ファイル
- `src/tools/vta/services/llm/eventPrompts.ts`
- `src/tools/vta/features/vta/utils/eventLedger.ts`
- `src/tools/vta/services/llm/client.ts`
- `tests/vta/llmArchitectureImprovements.test.ts`
- `docs/adr/0016-preliminary-classification-pipeline-separation.md`
- `docs/adr/README.md`
