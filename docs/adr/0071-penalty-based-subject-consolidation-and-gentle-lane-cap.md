# ADR-0071: ペナルティ目的関数による宣言的主体レーン統合最適化および最大レーン数超過への緩やかな凸ペナルティポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-22
- **Target Components**: `VTA Subject Consolidation`, `VTA Granularity Score`, `VTA Granularity Refinement`, `VTA Connection Proposal`, `VTA AI Diagnostics`, `VTA Relation Contract`
- **Related Requirements / ADRs**: [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0010](./0010-subject-poset-dag-and-canonical-inclusion.md), [ADR-0011](./0011-olap-drilldown-and-rollup-for-subject-poset.md), [ADR-0013](./0013-machine-lane-suppression-and-refinement-context-slicing.md), [ADR-0050](./0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0065](./0065-explicit-merge-slot-preservation-uncompressed-convergence-and-preliminary-ref-filtering.md), [ADR-0068](./0068-whack-a-mole-sibling-merge-guard-sole-others-unwrapping-and-suppress-hint-accuracy.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅構内触車事故（`2026-11-21T23:19:13.110Z` および `2026-11-21T23:33:51.025Z`）を含む一連の実機診断により、従来の手続き的主体統合アルゴリズム（`subjectRanking.ts`）に以下の根本的課題があることが明らかになった。

1. **ハード上限 `maxSubjects` と順序依存の手続き的スワップ連鎖による「モグラ叩き」現象**:
   - 複合組織事故では、独立組織（発注者・下請会社・列車）と現場チーム内の非対称役割（見張員・現場代理人・作業指揮者・被災作業員）の合計が 7〜10 主体に達する。
   - 従来の実装は `maxSubjects`（例: 6列）を断崖的なハード制約としたまま、「初期 Top-K 選出 → 1対1ハブ置換 → 葉置換 → Pass 1 枠予約 → Pass 2 ソフトガード → 単独展開」という順序依存の `if-else` 分岐で調整していたため、LLM の主体階層抽出のわずかなゆらぎで単一ファミリー（`S_WORK` 作業班系 4枠）が保持枠を独占し、主要な独立外部組織（`S_TOBU` 東武鉄道 ＋ `S_SUB` 下請会社）がともに `subject_others`（「その他の関係者」）へ押し出され、レーン内直列タイムライン骨格が失われていた。
2. **上流統合と下流粒度反復スコア `C1` の尺度不一致**:
   - `granularityScore.ts` の `C1` は `L > maxSubjects` を折れ線で急減点する一方、複数の主要組織が `subject_others` に混在集約されても減点しなかったため、仮に上流で `+1` 列を許容しても下流反復が押し戻す構造となっていた。
3. **Poset 中間組織（直接関与 0件）の空サブレーン化および接続提案・診断の細部不整合**:
   - 直接関与・関係端点が 0件の中間組織（`TRAIN_1020` 等）が上位親へ `merged_into` されると空のドリルダウン候補となっていた。
   - `proposeVTAConnections` に `{ terminator: '[完了]' }` が未指定で、`parseConnectionProposalTSV` が `[完了]` 行で `break` していなかった。またリトライ回復済みの `llm.failure` が診断遷移上で `issues: 1` のまま表示されていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **断崖効果（Cliff Effect）の排除と認知負荷特性への適合**: 1列超過は緩やかに許容し、2〜3列以上の過剰展開には急峻なブレーキをかける下に凸のペナルティ関数を用いること。
- **ハード不変条件とソフト制約の明確な分離**: 事実性・全イベント保持・DAG非巡回性・ユーザー明示指定（`forceRetain` / `explicitMerges`）・0関与組織除外はハード制約として厳守し、役割分離・`subject_others` 回避・最大レーン数超過を単一目的関数のペナルティ項として統一すること。
- **決定論的厳密解と高速性**: 関与主体数（通常 10〜20件）に対し、トポロジカル順の分枝限定法（Branch-and-Bound）と葉兄弟の対称性除去により、ブラウザ上で数ミリ秒以内に大域最適解を決定論的に求めること。
- **ステージ間の一貫性**: Stage 1（`subjectRanking.ts`）と Stage 1.5（`granularityScore.ts` / `granularityRefinement.ts`）で同じ優先順序を共有すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1**: 従来の手続き的スワップ連鎖の上に「単一Posetファミリー3枠以上占有時の再配分分岐」をさらに追加する。
  - *不採用理由*: 分岐順序への依存がさらに深まり、固定上限 6列で全ロールが厳密非対称を持つ過制約ケースを原理的に解決できない。
- **選択肢2（採用）**: 保持主体集合 `R` の選出を **ペナルティ項の総和最小化問題（宣言的組合せ最適化）** に置換し、最大レーン数超過には **緩やかな1次＋2次凸ペナルティ** を与え、`C1` スコアとも整合させる。

---

## 4. 決定事項 (Decision Outcome)

1. **ペナルティ目的関数による宣言的主体保持ソルバー (`solveOptimalSubjectRetention`)**:
   - `subjectRanking.ts` にて手続き的ハブ置換ループを廃止し、トポロジカル順 Branch-and-Bound ソルバーを導入する。
   - 各候補集合 $R$（総可視レーン数 $L = |R| + \mathbb{I}[|O(R)| \ge 2]$、1主体単独の `subject_others` は禁止）に対し、以下のペナルティ総和を最小化する：
     - **最大レーン数超過ペナルティ（緩やかな凸関数）**: $\Delta L = \max(0, L - K)$ に対し $\text{computeLaneOverflowPenalty}(\Delta L, K) = (0.42\,\Delta L + 0.28\,(\Delta L)^2)\cdot \min(1.45, 4.5 / \max(3, K))$（絶対上限 $\min(12, K + 3)$）。
     - **Merge Guard 違反ペナルティ**: 厳密非対称（`strictAsymmetry`：相互確認・物理影響・人員/回復移送・変動vs回復・異種帰結、および共有親への片側隠蔽）に `1.50`、ソフトガードに `0.20`（あわせて混合帰結 `E4:loss,E5:recovery` 時に個別イベントの `ev.outcome_kind` が代表種別 `analysis.outcome.kind` で上書き混入していた `evaluateMergeGuard` のバグも `else if` 化により修正）。
     - **同族ロール集約コスト vs `subject_others` 集約コスト**: 保持親への集約損失 `0.12 * v(u)`（`focus: low` 従属主体は `0.03 * v(u)`）に対し、親なし `subject_others` 集約にはバケットペナルティ（主要2主体以上混在時 `0.24`、通常 `0.10`）＋ `0.26 * v(w)` を課し、同一予算内では常に同族集約による `subject_others` 解消を優先する。
2. **0関与Poset組織の一貫除外と保持祖先への推移解決**:
   - 統合対象時に直接イベント・関係端点が 0件の非強制保持主体はすべて `excludedIds` へ分類し、`consolidateSubjects` で保持主体の `parentEntityId` / `parentEntityIds` を `basePoset` 上の極小保持祖先へ推移解決する。また `mergeTargetById` の推移閉包化を常時実行する。
3. **`granularityScore.ts` (`C1`) および `granularityRefinement.ts` の整合化**:
   - `C1` の超過減衰を緩やかな凸式 `1 - (0.20 * excess + 0.30 * excess^2) / max(2, targetMax)` とし、`subject_others` に非 `low`・非受動機器の主要主体が2件以上混在している場合は `-0.15` ペナルティを適用する。
   - `granularityRefinement.ts` で `subject_others` 複数集約時の `merge` 検討ヒントと `countAggregatedSubjects` 減少による構造改善判定を追加する。
4. **接続提案 `[完了]` 終端処理・診断リネージ・契約明記**:
   - `proposeVTAConnections` の `callLLMGateway` に `{ terminator: '[完了]' }` を指定し、`parseConnectionProposalTSV` は `[完了]` 行で即座に `break` する。
   - `aiDiagnostics.ts` でリトライ回復済みの `llm.failure` を `counts: { issues: 0 }` ＋ `[RECOVERED_RETRY]` として記録し、`RELATION_CONTRACT_PROMPT` と `public/prompts.json` に共有イベント間の同一主体 `dependency` 禁止を明記する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 鳩の巣原理による 6列境界での不連続な押し出し（単一ファミリー独占による `東武鉄道`・`下請会社` の匿名化）が解消され、6列で収まる場合は全実名6列に再配分され、厳密な役割非対称等で6列では過制約となる場合のみ緩やかに `+1` 列（7列）へ拡張される。
  - 手続き的なスワップ順序への依存がなくなり、LLM の主体分割粒度が変動しても決定論的に一貫した最適解が得られる。
- **トレードオフ・考慮事項**:
  - 厳密な役割非対称と複数の主要独立組織が同時に存在する複合事故では、設定目標 `maxSubjects`（例: 6）に対し `7`（最大 `maxSubjects + 3`、上限12）レーンが生成される場合がある（該当主体の `subjectRanking.ranks[].reason` にペナルティ最適化による超過許容理由を記録）。
- **影響ファイル**:
  - [src/tools/vta/features/vta/utils/subjectRanking.ts](../../src/tools/vta/features/vta/utils/subjectRanking.ts)
  - [src/tools/vta/services/generation/granularityScore.ts](../../src/tools/vta/services/generation/granularityScore.ts)
  - [src/tools/vta/services/generation/granularityRefinement.ts](../../src/tools/vta/services/generation/granularityRefinement.ts)
  - [src/tools/vta/services/llm/client.ts](../../src/tools/vta/services/llm/client.ts)
  - [src/tools/vta/features/vta/utils/connectionProposals.ts](../../src/tools/vta/features/vta/utils/connectionProposals.ts)
  - [src/tools/vta/services/diagnostics/aiDiagnostics.ts](../../src/tools/vta/services/diagnostics/aiDiagnostics.ts)
  - [src/tools/vta/features/vta/utils/relationContract.ts](../../src/tools/vta/features/vta/utils/relationContract.ts)
  - [public/prompts.json](../../public/prompts.json)
  - [src/tools/vta/features/vta/utils/subjectRanking.test.ts](../../src/tools/vta/features/vta/utils/subjectRanking.test.ts)
  - [src/tools/vta/services/generation/granularityScore.test.ts](../../src/tools/vta/services/generation/granularityScore.test.ts)
  - [src/tools/vta/features/vta/utils/connectionProposals.test.ts](../../src/tools/vta/features/vta/utils/connectionProposals.test.ts)
  - [tests/vta/consolidatedSubjectDrilldown.test.ts](../../tests/vta/consolidatedSubjectDrilldown.test.ts)
  - [tests/vta/aiDiagnostics.test.ts](../../tests/vta/aiDiagnostics.test.ts)
  - [docs/adr/README.md](./README.md)
