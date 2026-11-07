# ADR-0017: アンカリング思考順序に整合した帰結先行セクション出力順序アーキテクチャ (Outcome-First Anchoring Prompt Order)

- **ステータス**: Accepted
- **決定日**: 2026-11-07
- **対象コンポーネント**: Event Prompts (`eventPrompts.ts`), VTA Store (`vtaStore.ts`), VTA LLM Client (`client.ts`), Benchmark Suite (`hanedaBaseline.test.ts`)
- **関連要件 / ADR**: ADR-0001, ADR-0015, ADR-0016

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港航空機衝突事故報告書（約28,500文字）などの長大インシデント文書に対する実LLMベンチマーク計測において、以下の課題が確認された。

1. **思考手順指示（アンカリング順）と TSV 出力順序の乖離**:
   - `EXTRACTION_ANCHORING_POLICY` では「1. 帰結アンカーの特定 $\to$ 2. 主体とPoset包含階層の構成 $\to$ 3. 時系列イベントと主体割当 $\to$ 4. 主体間・時系列関係の構成」という4段階の思考手順を指示している。
   - しかし、従来の TSV テンプレートは `[主体]` $\to$ `[イベント]`（数十行） $\to$ `[関係]`（数十行） $\to$ `[共有カード]` $\to$ `[整理]` $\to$ `[帰結]`（末尾）という順序であった。
   - モデルは序盤のイベントや関係を出力する段階で、末尾に出力すべき「最終的な帰結はどれか」を先回り推論しなければならず、注意機構（Attention）の無駄な消費と生成所要時間の長期化を招き、180秒のクライアントタイムアウトに達するケースがあった。
2. **前方参照とパース方針の整合性**:
   - 先頭で `[帰結]` を出力させる場合、モデルは後続の `[イベント]` で採番する予定のイベントID（例：`E_loss` や `E40`）を先頭で指定することになる。
   - 段落一致などでイベントIDをヒューリスティックに推測・自動補正するアプローチは、多数のイベントが同一段落を参照するインシデント文書において一意に解決できず、`parseLedger` の「意味を推測して勝手に補正しない」事実性原則（ADR-0001）に違反する。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **思考順序と出力順序の完全一致**: アンカリングの思考手順（帰結アンカー $\to$ 主体階層 $\to$ イベント $\to$ 関係）の順にそのまま TSV を出力させることで、モデルの認知的オーバーヘッドを最小化し、生成を安定・高速化すること。
- **ヒューリスティックな ID 推測の排除**: 段落照合による勝手なイベントID補正は一切行わず、LLM が先頭で指定したイベントIDが後続のイベント一覧に存在することを決定論的に検証すること。不整合があれば既存の厳格な行修復（`ledgerRepairInput`）に委ねる。
- **フラグによるオプトインと後方互換性**: 既存の `event-chain` / `fulltext-ledger` 方式や既存の単体テストを一切壊さず、新機能（`outcomeFirst`）はオプトイン制御とすること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 1: 全方式で一律に出力順序を強制変更し、帰結IDの不整合時に段落一致でイベントIDを自動補正する**:
  - *却下理由*: 羽田事故データのように同一段落（`p1` など）を数十のイベントが参照する場合に一意解決できず、事実性を損なう。
- **選択肢 2: フラグ（`outcomeFirst`）による制御を導入し、`[帰結]` を `[主体]` の前に先行出力させる。台帳検証（`inspectLedger`）は全行走査後に行われる既存の仕組みを活用する（採用）**:
  - `inspectLedger` はセクション種別ごとに `doc.rows` を走査するため、TSV 内で `[帰結]` が先頭にあっても、全イベントがメモリ上に蓄積された後に帰結が検証されるため、パース上の前方参照問題は自然に解消される。

---

## 4. 決定事項 (Decision Outcome)

### 4.1 帰結先行ポリシーと出力順序テンプレートの新設 (`eventPrompts.ts`)
1. `OUTCOME_EXTRACTION_FIRST_POLICY` を新設し、「アンカリング思考手順に従い、[主体]セクションの前に必ず次の5列TSVを1行出す。後続の[イベント]セクションに出力する帰結イベントのIDを指定すること。」と明示。
2. `SECTION_ORDER_ANCHOR_FIRST_POLICY` を定義し、`[帰結]` $\to$ `[主体]` $\to$ `[イベント]` $\to$ `[関係]` $\to$ `[共有カード]` $\to$ `[整理]` の出力順序を規定。
3. `compileNormalizationSystemPrompt` に `outcomeFirst?: boolean` オプションを追加し、`outcomeFirst: true` の時にこれらをべき等に合成。

### 4.2 設定ストアとクライアント統合 (`vtaStore.ts`, `client.ts`)
1. `vtaStore.ts` に `outcomeFirstNormalization: boolean`（既定: `false`）および `setOutcomeFirstNormalization` を追加し、永続化をサポート。
2. `extractEventDraft` のオプション引数に `outcomeFirst?: boolean` を追加し、`useVTAStore` の設定または引数の指定をプロンプト合成に反映。

### 4.3 ベンチマーク実行スクリプトの対応 (`hanedaBaseline.test.ts`)
1. 環境変数 `OUTCOME_FIRST=1` をサポートし、実機ベンチマーク計測において Phase A（末尾帰結）と Phase B（帰結先行）を即座に A/B 比較できる構成を整備。

---

## 5. 結果と影響 (Consequences)

### メリット
- **思考負荷の削減と生成の安定化**: 最初に基準点（帰結）を宣言してから主体・イベント・関係を展開するため、モデルが迷わず直線的に出力でき、タイムアウトの抑止が期待される。
- **既存アーキテクチャとの自然な調和**: `inspectLedger` のセクション別処理順序のおかげで、TSV 上の順序が入れ替わってもパーサー側の修正を一切必要とせず、完全な互換性を保持。

### トレードオフ・考慮事項
- **実機ベンチマーク計測（Gate B）による判定結果**:
  - 羽田事故データ（約28,500文字、モデル: `openrouter/google/gemini-3.8-flash`）での実機計測（2試行）では、2試行とも約96〜102秒で「台帳を修復できませんでした（修復応答は指定した行IDを一度ずつ出力する必要があります）」により失敗した。
  - **原因は未特定**である。ベンチマークは LLM の生応答と検証 issue を保存していないため、先頭 `[帰結]` のイベントID前方参照の不一致が原因かどうかは確認できていない（仮説に留まる）。確認には `debugRecorder` の `ledger.validation` 記録の取得が必要。
  - Phase A（同一条件・末尾帰結）は2試行中1試行が完走、Phase B は2試行とも失敗した。
  - 一方、Phase A（末尾帰結・仮判定分離）では 170.1秒で Stage 1a $\to$ Stage 1b $\to$ Stage 2 $\to$ 自動接続まで完全完走（イベント39件、主体12件、Poset包含枝15本、帰結判定成功）を達成している。
  - したがって、計画書 Rev.2 の Gate B 判定基準（「修復回数が増えないこと。満たさなければ採用しない」）に従い、**帰結先行順序は既定（デフォルト）としては採用せず、オプトインの実験的フラグ（既定オフ）として保持する**。
  - これにより、システムの本番稼働における安定性を完全に担保しつつ、将来のモデル進化における比較検証可能性を確保する。

### 影響ファイル
- `src/tools/vta/services/llm/eventPrompts.ts`
- `src/tools/vta/features/vta/store/vtaStore.ts`
- `src/tools/vta/services/llm/client.ts`
- `tests/vta/llmArchitectureImprovements.test.ts`
- `tests/benchmark/hanedaBaseline.test.ts`
- `docs/adr/0017-outcome-first-anchoring-prompt-order.md`
- `docs/adr/README.md`
