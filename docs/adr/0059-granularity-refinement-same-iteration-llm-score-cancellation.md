# ADR-0059: 粒度反復の採否判定における LLM 主観スコアの同一反復内相殺ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-20
- **Target Components**: `VTA Granularity Refinement`
- **Related Requirements / ADRs**: [ADR-0050](./0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0058](./0058-granularity-score-global-rank-crossing-and-causal-reachability.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

粒度反復（`refineGranularity`）では、各反復で LLM が現在の最良スキーマ（`bestSchema`）をレビューし、主観スコア（`C2` / `C4` / シナリオ評価）と修正操作を返す。主観スコアは **LLM がレビューした `bestSchema` に対する評価**であり、修正操作を適用した後の候補スキーマに対する評価ではない。

従来の採否判定は反復によって比較方法が違っていた。

- **#1**：同じ反復の LLM スコアを最良側・候補側の両方に当てはめていた（`hasLLMScoreBaseline = false`）。そのため LLM スコアは打ち消し合っていた。
- **#2 以降**：候補側のスコア `nextScore` には今回の LLM スコアを使い、基準側には前回採用時の `bestScore`（前回の LLM スコア込み）を使っていた。

その結果、2回目以降の採否は「候補で機械指標が良くなったか」ではなく、**前回と今回の LLM 採点の差**に左右されていた。具体的には次の2通りの誤判定が起きる。

- 機械指標が改善しているのに、LLM の採点が下がっただけで不採用になる。
- 機械指標が少し悪化しているのに、LLM の採点が上がっただけで採用される。

## 2. 決定理由の要因・制約 (Decision Drivers)

- 採否は**候補そのものの改善**で決めなければならない。
- 1反復あたりの LLM 呼び出しを増やさない（追加のコストや遅延を出さない）。
- ADR-0050 の厳格な採否ゲート（`machineNotDegraded`、G1〜G4）と、ADR-0058 の機械指標を維持する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢A：毎回、今回の LLM スコアで基準スコアを計算し直す（採用）**
  - LLM スコアは比較の両側で打ち消し合い、採否は機械指標と図の構造の改善で決まる。追加の通信はない。
- **選択肢B：候補スキーマを LLM にもう一度採点させる**
  - 正確だが、反復ごとに通信が1回増え、コストと遅延が約2倍になる。
- **選択肢C：現状維持**
  - 採点のぶれで採否が決まる問題が残る。

## 4. 決定事項 (Decision Outcome)

選択肢Aを採用する。

1. `hasLLMScoreBaseline` を廃止し、すべての反復で `comparableBestScore` を「`bestSchema` の機械指標 + 今回の LLM スコア」で計算する。シナリオ評価の混合は `0.4 × C3 + 0.6 × scenarioScore` とする。
2. 図の構造の改善による採用条件（`machineOrTopologyImproved`：機械指標の改善、表示カードの減少、表示エッジの増加）を、#1 に限らず全反復に適用する。反復回数は `maxIterations` で上限があるため、無限に続くことはない。
3. ログの `前回基準` と `iterations[].score` は、今回の LLM スコアに基づく値として表示する。

## 5. 結果と影響 (Consequences)

### メリット
- 2回目以降の採否が、LLM 採点のぶれではなく候補の実質的な改善で決まる。
- 1回目と2回目以降で判定方法が揃い、挙動を予測しやすくなる。

### トレードオフ・考慮事項
- LLM の主観スコアは採否に影響しなくなる。主観スコアは、レビュー対象の評価としての記録・表示と、終了判定（`targetScore`）にのみ使われる。
- 反復をまたいだ `S` の推移は、採点基準が反復ごとに異なるため、厳密な単調増加を意味しない。

### 影響ファイル
- [src/tools/vta/services/generation/granularityRefinement.ts](../../src/tools/vta/services/generation/granularityRefinement.ts)
- [src/tools/vta/services/generation/granularityRefinement.test.ts](../../src/tools/vta/services/generation/granularityRefinement.test.ts)
- [docs/adr/README.md](./README.md)
