# ADR-0067: スケール適応型C5認知負荷評価・事後活動除外スコープの粒度反復同期およびLLM反復通信効率化ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-22
- **対象コンポーネント**: VTA Engine (`granularityScore`, `granularityRefinement`, `chainRepairService`, `llm/client`, `vtaStore`, `contextEvidencePolicy`, `aiDiagnostics`)
- **関連ドキュメント・コミット**: ADR-0007, ADR-0033, ADR-0048, ADR-0052, ADR-0058, ADR-0063, ADR-0065, ADR-0066

## 1. コンテキストと課題 (Context & Problem Statement)

大規模な事故調査報告書（例: 68イベント・96カード・6レーン構成）の `refined-chain` 自動生成トレースにおいて、幾何レイアウト監査（`layout.audit: issues: 0`）および主体の親組織ハブ統合は健全に完了していた一方、多目的最適化スコア・LLM通信回数・診断トレースの観点で以下の課題が確認された：

1. **定数閾値による認知負荷指標 `C5` の床張り（`0.03`）と勾配消失リスク**:
   `computeMachineMetrics` の `cardPenalty = max(0, totalNodes - 24) / 24` および `depthPenalty = max(0, maxLaneNodes - 12) / 12` がイベント件数に依存しない固定定数であったため、68イベント（96カード）規模では `0.25 * 3.00 = 0.75` が単独で減算されて `C5 = 0.03` に張り付き、総合スコア `S` を恒常的に `0.71` 付近へ押し下げるとともに過密警告を誤発火させていた。一方で単純なハードクランプ `[0, 1]` を導入すると `L > 2 * maxSubjects` 領域で `C1 = 0` と同時に勾配がゼロになる死角が生じ、また `C5` 正常化によって `bestScore >= targetScore` が初回から成立することで `C3` 未収束のまま `#1` で早期終了する副作用リスクがあった。
2. **粒度反復レビュー（`granularity.refinement`）と事後活動除外（`filterPostOutcomeScope`）のスコープ不整合および重複関係提案**:
   `filterPostOutcomeScope` は `refineGranularity` 完了後に実行されるため、`excludePostOutcomeActivities` が有効な状態でも `buildReviewUserPrompt` の `【シナリオに含まれていないイベント一覧】` に事後調査ノードが提示され、後段で破棄される事後ノードや既接続カードペアへの重複 `add_relation` に反復枠が消費されていた。
3. **非投影差分のみの連鎖補完 Pass 2 実行および事前仮判定の端数チャンク分割**:
   - `proposeChainRepair` の Pass 1 が図上に投影されない `before` 関係と `要確認` のみを返した場合でも、グラフ構造（連結成分・カード・割当）が不変のまま全文コンテキストの Pass 2 通信が実行されていた。
   - `populatePreliminaryClassifications` が固定 `CHUNK_SIZE = 60` で分割していたため、66件の対象イベントが `60 + 6` 件に分割され、端数6件のために2往復目の全文段落＋推論オーバーヘッドが発生していた。
   - `refineGranularity` 呼び出し元および `proposeChainRepair` に `[完了]` ストリーム早期終了指定が渡されていなかった。
4. **関係端点の宛先名推測と `[台帳修復]` 参照リネージの判読性**:
   発話内容の宛先名と次イベントの実際の割当主体が異なる場合に `transfer` 先主体不一致（初回修復対象）が発生しやすかった。また `[台帳修復]` 警告文に許容条件として言及されたイベントIDが、直接の修復対象行と区別なく `MUTATED` として表示されていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **スケール不変性と単調勾配の両立**: 小規模事例（`<= 20` イベント）では従来の閾値（`24` 枚 / 1レーン `12` 枚）を完全維持しつつ、大規模事例でも `C5` が床張りせず、かつ極端なレーン超過領域でも正の改善勾配を失わないこと。
- **因果連結性 `C3` 未収束時の早期終了防止**: `C1`・`C5` が高スコアであっても、機械 `C3` が `targetScore` 未満の間は反復上限内で連結改善を継続すること。
- **ユーザー設定（ADR-0007）とレジリエンス保護（ADR-0033 / ADR-0048）の厳守**: 事後活動除外が有効なときのみ非レジリエンス事後ノードを未包含一覧から除外し、後半段落で言及された事故前イベント（`EventTimeDAG` 先行）やレジリエンス回復ノードは保護すること。
- **既存テスト・型契約との完全互換性**: `RefinementChatCaller` の4引数シグネチャ、`PRELIMINARY_CLASSIFICATION_PROMPT`（`[完了]` 非出力）、`public/prompts.json` 同期検証、および `traceEntityLineage` の既存テスト契約を壊さないこと。

## 3. 検討した選択肢 (Considered Options)

- **選択肢A**: `C5` の各ペナルティを `clamp01` でハードクランプし、`targetMaxLaneNodes` の分母に現在の可視レーン数 `L` を用い、事後ノード除外を独自正規表現で無条件適用する。
  - *却下理由*: 過剰 `merge` で `L` が減るほど1レーン許容枚数が膨張する逆インセンティブが生じ、`L > 2 * maxSubjects` で `C1`・`C5` 双方が勾配ゼロとなるほか、`excludePostOutcomeActivities = false` 設定時や否定表現（`"脱出できず"`）で不整合を起こす。
- **選択肢B（採用）**:
  1. 分母を設定上限 `budgetLanes = max(2, maxSubjects)` に固定した `computeComplexityBudgets`（`targetMaxCards = max(24, ceil(N * 1.15))`、`targetMaxLaneNodes = max(12, ceil((N / budgetLanes) * 2.2))`）と漸近飽和関数 `softCap01(x) = x / (1 + x)` を導入し、早期収束条件に `mNextRawC3 >= targetScore` を加える。
  2. `collectPostOutcomeExcludedNodeIds` を `filterPostOutcomeScope` と共通化し、`excludePostOutcome` オプションが有効な場合のみ未包含一覧から除外する。
  3. `proposeChainRepair` の可視構造不変時 Pass 2 スキップ、`populatePreliminaryClassifications` の上限80件均等チャンク分割、`[完了]` 必須ステージへの `{ terminator: '[完了]' }` 注入、相手側割当主体確認ルール同期、および `[参照関与]` リネージ注記を導入する。

## 4. 決定事項 (Decision Outcome)

選択肢Bを採用し、以下のアーキテクチャ変更を実施した：

1. **スケール適応型 `C5` 評価・漸近飽和および `C3` 収束ガード (`granularityScore.ts`, `granularityRefinement.ts`)**:
   - `computeComplexityBudgets(activeEventCount, maxSubjects)` を新設し、小規模事例の互換性を保ちながら大規模事例での `C5` 床張りと偽陽性過密ヒントを解消した。
   - 各サブペナルティに単調増加の漸近飽和 `softCap01(x) = x / (1 + x)` を適用し、`topologyImproved` に上限超過時のレーン削減判定を追加した。
   - 反復終了判定を `bestScore >= targetScore && mNextRawC3 >= targetScore && machineDelta < epsilon` とし、`C3` 未収束時の早期打ち切りを防止した。
2. **事後除外対象ノード判定の共通化と重複関係抑止 (`granularityScore.ts`, `granularityRefinement.ts`, `client.ts`, `vtaStore.ts`)**:
   - `collectPostOutcomeExcludedNodeIds` を切り出し（共有カード同居による `EventTimeDAG` 汚染を避けつつ、後半段落の振り返り記述であっても個別イベントの厳密時刻区間 `parseTimeInterval` が帰結より前のイベントは保護）、`excludePostOutcome` 有効時のみレビュープロンプトの未包含イベント一覧から除外した。
   - `GRANULARITY_REVIEW_SYSTEM_PROMPT` に非投影 `before` 指定不可および既存意味関係カードペアへの重複追加禁止を明記した。
3. **LLM パス効率化とストリーム早期終了 (`chainRepairService.ts`, `client.ts`, `vtaStore.ts`)**:
   - `proposeChainRepair` にて、Pass 1 で可視グラフ構造を変える追加（主体・イベント・割当・`before` 以外の関係）がなく連結成分数も減少しなかった場合は Pass 2 をスキップする。
   - `populatePreliminaryClassifications` の上限を `80` 件とし、`chunkCount = ceil(N / 80)` に基づく均等チャンク分割（例: 66件→1回、86件→`43 + 43`）へ変更した。
   - `[完了]` 出力を必須とする `refineGranularity` 呼び出し元ラッパーおよび `proposeChainRepair` に `{ terminator: '[完了]' }` を適用した。
4. **相手側割当主体確認ポリシー同期と診断リネージ明確化 (`contextEvidencePolicy.ts`, `public/prompts.json`, `aiDiagnostics.ts`)**:
   - `CONTEXT_EVIDENCE_POLICY` および `public/prompts.json`（`normalization`・`connectionProposal`）に、発話の宛先名から推測せず相手側イベントの実割当主体IDと照合する規則を追記した。
   - `traceEntityLineage` にて `[台帳修復]` 警告の直接修復対象ID以外の関与エンティティには `note` 先頭へ `[参照関与] ` を付記し、既存テスト互換性と判読性を両立した。

## 5. 結果と影響 (Consequences)

### メリット
- 60〜80イベント級の大規模報告書で `C5` が健全域（`~0.90`）で機能し、カード整理・レーン統合・因果接続すべてに対して滑らかな改善勾配と適切な反復継続が保証される。
- 不要な事後調査ノード接続、重複関係提案、非投影 `before` のみの連鎖補完 Pass 2、および端数チャンク仮判定通信が削減され、精度を損なわずに総LLMレイテンシを大幅に短縮できる。

### トレードオフ・考慮事項
- 1チャンク最大80イベントの事前仮判定では1回あたりの出力行数が最大80行（約3,500〜4,500文字）となるが、現行モデルの出力上限に対して十分な余裕があり、段落文脈の重複送信がなくなる分トータルトークン量も削減される。

### 影響ファイル
- `src/tools/vta/services/generation/granularityScore.ts`
- `src/tools/vta/services/generation/granularityScore.test.ts`
- `src/tools/vta/services/generation/granularityRefinement.ts`
- `src/tools/vta/services/generation/granularityRefinement.test.ts`
- `src/tools/vta/services/generation/chainRepairService.ts`
- `src/tools/vta/services/generation/chainRepairService.test.ts`
- `src/tools/vta/services/llm/client.ts`
- `src/tools/vta/features/vta/store/vtaStore.ts`
- `src/tools/vta/services/llm/contextEvidencePolicy.ts`
- `public/prompts.json`
- `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- `tests/vta/llmArchitectureImprovements.test.ts`
- `tests/vta/aiDiagnostics.test.ts`
- `docs/adr/0067-scale-adaptive-c5-post-outcome-refinement-scope-and-llm-pass-efficiency.md`
- `docs/adr/README.md`
