# ADR-0065: 明示マージ元の保持枠除外・非圧縮機械スコア収束判定および仮判定部分範囲外参照救済ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-21
- **Target Components**: `VTA Subject Consolidation`, `VTA Granularity Refinement`, `VTA Event Ledger`, `VTA LLM Pipeline`, `VTA AI Diagnostics`
- **Related Requirements / ADRs**: [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0016](./0016-preliminary-classification-pipeline-separation.md), [ADR-0059](./0059-granularity-refinement-same-iteration-llm-score-cancellation.md), [ADR-0063](./0063-granularity-machine-adoption-hub-exemption-and-parent-others-guard.md), [ADR-0064](./0064-chain-review-relation-targets-acyclic-parent-hub-merge-and-semantic-pair-upgrade.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅構内触車事故シナリオ（イベント24件・カード43枚・エッジ60本）の AI 診断トレース（`2026-11-20T23:52:22.727Z`）において、初回台帳一発通過・幾何監査 `issues: 0` が達成された一方で、以下の 3つの構造的不整合が確認された。

1. **明示 `merge` 元による保持枠占有と `subject_others` 押し出し**:
   - 粒度反復 `#1` で `merge:A_WORKER_H->A_CREW`（上限6列）を適用した際、`rankSubjects`（`subjectRanking.ts`）は `A_WORKER_H` を候補配列に含めたまま上位枠を割り当て、関数末尾で `retainedIds.delete('A_WORKER_H')` を実行していた。
   - このため高スコアの `A_WORKER_H` が上位枠を 1枠空費して消え、`A_OFFICE`（工務事務所）と `A_CONTRACTOR`（下請会社）の双方がオーバーフロー側へ追いやられた結果、上限 6枠に 1枠空きがあるにもかかわらず計 5レーン・2件混在の `subject_others` が生成されていた。
2. **粒度反復の `scenarioScore` 混合による見かけ上のスコア低下と早期打ち切り**:
   - `granularityRefinement.ts`（ADR-0063）で採否判定自体は純機械スコア比較に正規化されたものの、収束打ち切り判定が引き続き `bestScore - prevBestScore < epsilon`（`0.4 * ΔC3` 圧縮込み）を参照しており、`#1` の実質機械スコア改善 `+0.033 >= 0.02` が `0.852 - 0.840 = +0.012 < 0.02` として早期終了していた。
   - さらにログおよび Stage 2 パイプライン履歴（`client.ts`）が純機械指標（`0.91 → 0.98`）と `scenarioScore` 混合値を区別せず並べていたため、見かけ上 `S=0.897 → 0.852` へ悪化したように誤認された。
3. **仮判定の部分範囲外参照破棄と Section 4 における `excluded` 状態の不可視**:
   - `inspectPreliminaryClassifications`（`eventLedger.ts`）は `[仮判定]` 行がイベント自身の段落に加えて比較用の規程段落等を 1つでも併記すると行全体を例外棄却し、`populatePreliminaryClassifications`（`client.ts`）も未付与イベントIDや `issues` を記録していなかった。
   - また `aiDiagnostics.ts` Section 4 が `excluded: true`（イベント0件除外）を出力せず、保持レーンと区別できなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- 明示マージ元主体に保持枠を浪費させず、かつ統合先ハブ主体が常に保持されるよう枠配分を整合させること。
- `targetScore` 到達後の継続/停止判定から `scenarioScore` による `0.4` 倍重み圧縮歪みを完全に取り除き、機械スコアの同一尺度で比較表示すること。
- 仮判定で正当な行為段落を含まない完全範囲外参照は引き続き拒否しつつ、部分的な補助段落併記に対しては過度に厳格な全行棄却を避けること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 事後的に `subject_others` から 1件引き戻す**
  - *課題*: `A_OFFICE` と `A_CONTRACTOR` の双方が既に `subject_others` に入ってしまった後では 1枠空きを埋めきれず、統合元・統合先が別構成のとき上限超過や枠余りが再発する。
- **選択肢2 (採用): 枠配分前に `explicitMerges` ソースを `retainableCandidates` から除外・ターゲットを強制保持し、収束判定を `machineDelta < epsilon` へ切替え、仮判定参照の `inScopeRefs` 抽出と `excluded` 診断出力を追加する**
  - *利点*: `explicitMerges` ソース・ターゲット双方の位置によらず常に正確に `effectiveLimit` 枠を使い切り、`ranks` 上の整合性と収束判定の一貫性を両立できる。

---

## 4. 決定事項 (Decision Outcome)

1. **`subjectRanking.ts` の明示マージ枠配分適正化**:
   - `rankSubjects` の枠配分（`topNIds` / `keepCount`）前に `explicitMerges` のソース主体集合（多段連鎖解決済み）を `retainableCandidates` から除外し、ターゲット主体を `effectiveForceRetain` に含めて優先保持する。`ranks` 出力配列自体は引き続き全 `baseEntities` に対して生成する。
2. **`granularityRefinement.ts` / `client.ts` の非圧縮収束判定・可視化**:
   - `refineGranularity` の継続/停止条件 `bestScore >= targetScore && machineDelta < epsilon` で純機械スコア差分 `machineDelta = nextMachineScore - comparableMachineBaseline` を用い、`logTrace` に `[機械C3=..., シナリオ=...]` を併記する。
   - `client.ts` の Stage 2 履歴説明文は `computeMachineMetrics` に基づく同一スケールの `機械S=初期 → 最終` を表示する。
3. **`eventLedger.ts` / `client.ts` / `aiDiagnostics.ts` の仮判定救済・可観測性向上**:
   - `inspectPreliminaryClassifications` はイベント固有 `sourceRefs` との共通集合 `inScopeRefs` が 1件以上あればそれを警告付きで保持し、0件の場合のみ例外とする。
   - `populatePreliminaryClassifications` は未付与イベントIDと構文 `issues` をログ・`debugRecorder` に記録する。
   - `aiDiagnostics.ts` の `SubjectHierarchySummary` に `excluded?: boolean` を追加し、`subjectRanking.ranks` で `excluded && !retained` となった主体に `excluded: true` を出力する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 粒度反復での `merge` 後に保持レーン枠の空費・`subject_others` への不要な押し出しがなくなり、空いた枠に工務事務所や請負会社等の重要組織を独立レーンとして維持できる。
  - `scenarioScore` 混合時に真の機械改善（`>= epsilon`）が `#1` で誤停止せず後続反復へ進められる。
  - 診断トレースで `A_CORP` 等の0件除外主体と保持主体が明確に区別され、仮判定の欠落原因も即座に追跡できる。
- **トレードオフ・考慮事項**:
  - 明示マージ元は `retainableCandidates` から外れるが、元の `candidates` と最終 `ranks` には残るため `mergedInto` 履歴および `revertConsolidation` の可逆性は完全に保たれる。
- **影響ファイル**:
  - [subjectRanking.ts](../../src/tools/vta/features/vta/utils/subjectRanking.ts)
  - [granularityRefinement.ts](../../src/tools/vta/services/generation/granularityRefinement.ts)
  - [client.ts](../../src/tools/vta/services/llm/client.ts)
  - [eventLedger.ts](../../src/tools/vta/features/vta/utils/eventLedger.ts)
  - [aiDiagnostics.ts](../../src/tools/vta/services/diagnostics/aiDiagnostics.ts)
  - [subjectRanking.test.ts](../../src/tools/vta/features/vta/utils/subjectRanking.test.ts)
  - [granularityRefinement.test.ts](../../src/tools/vta/services/generation/granularityRefinement.test.ts)
  - [llmArchitectureImprovements.test.ts](../../tests/vta/llmArchitectureImprovements.test.ts)
  - [aiDiagnostics.test.ts](../../tests/vta/aiDiagnostics.test.ts)
  - [docs/adr/README.md](./README.md)
