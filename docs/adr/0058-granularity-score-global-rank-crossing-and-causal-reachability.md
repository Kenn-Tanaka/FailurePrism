# ADR-0058: 粒度評価スコア (granularityScore) のグローバル時間ランク交差判定・有向到達率併用および過密ペナルティ是正ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA Granularity Score`, `VTA Granularity Refinement`
- **Related Requirements / ADRs**: [ADR-0034](file:///docs/adr/0034-row-cell-layout-and-matrix-event-time-dag.md), [ADR-0044](file:///docs/adr/0044-connection-proposal-prefilter-history-preservation-and-diagnostics-accuracy.md), [ADR-0050](file:///docs/adr/0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0056](file:///docs/adr/0056-gateway-retry-observability-cross-lane-geometry-trace-and-temporal-inversion-guard.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

長大シナリオ（例：羽田空港衝突事故・イベント47〜51件、カード62〜65件）における粒度反復（`granularity.refinement #1`）で、LLM が断裂していた因果連鎖を補完する正当な関係追加提案（`add_relation:rel_ref_M1`）を出力したにもかかわらず、機械評価指標 `C5` の微減（`0.31 → 0.30`）によって総合スコア `S` が `0.725 → 0.723` に下がり、不採用（`理由: スコア未改善`）となる現象が確認された。

調査の結果、`granularityScore.ts` の `computeMachineMetrics` に以下の3つの構造的不整合が存在することが判明した。

1. **`crossPenalty` におけるローカル `sequence_order` 比較による偽交差計上**:
   - `crossingCount` がノードの垂直位置として `n.sequence_order`（各レーン内のローカル連番 `0, 1, 2...`）を使用していた。
   - カード枚数の異なるレーン間で時間的に平行なクロスレーンエッジを追加すると、ローカル連番の大小逆転（例: `seq=18` と `seq=2`）によって実際には交差していない他エッジとの「偽の交差」が計上されていた。
2. **`maxDegree` の重複辺二重カウントおよび `depthPenalty` の因果連鎖長ペナルティ**:
   - 同一ノードペア間に共有破線（`association`）と意味関係（`transfer` 等）が併存すると次数が二重カウントされていた。
   - また `depthPenalty` が可視グラフ全体の最長有向パス長（`longestPath > 12`）を減点対象としていたため、長大シナリオで断裂していた因果連鎖が連結されてパスが伸びるほど `C5` が悪化する自己矛盾が生じていた。
3. **`C3` の `variationReachability` が共有破線（`association`）による無向連結のみで飽和**:
   - `extractCausalScenario`（プロンプトの未包含イベント判定）は `meaning !== 'association'` の因果エッジのみを辿るのに対し、`variationReachability` は `association` エッジも含めて計算していたため、共有破線頼みで有向関係が欠落した変動イベントに対して有向関係を追加しても `C3` が全く改善しなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **副作用の最小化**: スコア基準の大幅なかさ上げによる反復の早期打ち切り（`bestScore >= targetScore` での1回目終了）や、通常事象（`normal`）への過剰な矢印追加を誘発しないこと。
- **既存採否ゲートの保全**: `granularityRefinement.ts` の `before` 不採用判定や `hubPenalty` の過密抑止力（分母 `/ 4`）を弱めないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **オプションA: `depthPenalty` を削除し、`hubPenalty` 分母を緩和し、`C3` に全通常ノードの到達率を加える**
  - *問題点*: `C5` ベースラインの上昇による反復早期打ち切り、真のハブ過密に対する抑止低下、および通常事象への過剰接続リスクがある。
- **オプションB: `granularityScore.ts` の指標計算バグ3点のみを精密に是正する（採用）**
  - `crossPenalty` は `computeEventRanks(visible)` による全レーン共通の時間行ランクで判定する。
  - `maxDegree` はユニーク隣接ノード数（単純グラフ次数）で計測し（分母 `/ 4` は維持）、`depthPenalty` は `longestPath` ではなく単一レーン内最大カード数（`maxLaneNodes > 12`）で評価する（`details.longestPath` の算出・出力は維持）。
  - `variationReachability` は変動イベント（`variation`）のみを対象としたまま、「全エッジ到達率（`0.5`）」と「有向因果エッジ（`meaning !== 'association'`）のみの到達率（`0.5`）」の加重平均とする。

---

## 4. 決定事項 (Decision Outcome)

1. **`granularityScore.ts` (`computeMachineMetrics`) の `C3` 改善**:
   - `collectReachableFromOutcome(excludeAssociation)` により、全可視エッジ到達集合と有向因果エッジ（`edge.meaning !== 'association'`）のみの到達集合の双方を計算し、`variationReachability` を両者の均等平均（`0.5 * allEdge + 0.5 * causal`）とする。
2. **`granularityScore.ts` (`computeMachineMetrics`) の `C5` 是正**:
   - `neighbors: Map<string, Set<string>>` により重複辺を除外したユニーク隣接ノード数で `maxDegree` を計測する。
   - `computeEventRanks(visible)` により全レーン共通の `EventTimeDAG` 時間ランクを取得し、`crossingCount` の交差判定に用いる。
   - `depthPenalty` の入力を `longestPath` から単一レーン内最大カード数 `maxLaneNodes` へ変更する。

---

## 5. 結果と影響 (Consequences)

### メリット
- 長大シナリオにおける正当な `add_relation` 提案が、ローカル連番による偽交差や `longestPath` 伸長ペナルティによって自己否定されなくなる。
- 共有イベント破線（`association`）のみで繋がっていた変動イベントへ明示的な有向因果関係を補完した際、`C3` の改善として正当に評価される。

### 影響ファイル
- [src/tools/vta/services/generation/granularityScore.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/services/generation/granularityScore.ts)
- [src/tools/vta/services/generation/granularityScore.test.ts](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/src/tools/vta/services/generation/granularityScore.test.ts)
- [docs/adr/0058-granularity-score-global-rank-crossing-and-causal-reachability.md](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/docs/adr/0058-granularity-score-global-rank-crossing-and-causal-reachability.md)
- [docs/adr/README.md](file:///c:/Users/kenta/Dropbox/2026年/ソフトウェア開発/2026-10-17_FailurePrism/docs/adr/README.md)
