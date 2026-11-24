# ADR-0075: 主体統合エンジンの単一分枝限定ソルバーへの一本化・Stage 2 カード非表示(`suppress`)誘導の廃止および Stage 3 未割当イベント網羅検証ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-23
- **対象コンポーネント**: VTA Engine (`subjectRanking`, `granularityRefinement`, `chainRepairService`, `autoConnectionService`), Diagnostics Infrastructure (`aiDiagnostics`)
- **関連ドキュメント・コミット**: [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0067](./0067-scale-adaptive-c5-post-outcome-refinement-scope-and-llm-pass-efficiency.md), [ADR-0071](./0071-penalty-based-subject-consolidation-and-gentle-lane-cap.md), [ADR-0072](./0072-deferred-final-phase-subject-others-consolidation.md), [ADR-0074](./0074-vta-poset-merge-direction-casualty-outcome-protection-and-two-tier-diagnostics.md), [開発ロードマップ](../ROADMAP.md) (`RM-ARCH-01`〜`03`)

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線 新鹿沼駅構内触車死亡事故の AI 診断 v2.0 トレース検証において、ADR-0074 により死傷者・複数帰結の保護は正常機能した一方、歴史的に積み重ねられた複数ステージ間の**責務重複（Split-Brain）**に起因する以下の3つの不整合が特定された。

1. **主体統合エンジンの二重化による中核当事者の誤吸収（`RM-ARCH-01`）**:
   - `subjectRanking.ts` 内に、宣言的な分枝限定ペナルティ最適化器 `solveOptimalSubjectRetention`（ADR-0071）と、最終フェーズ用の手続き的3段階ループ `consolidatePeripheralSubjectsToOthers`（Sub-step B0 → B1 → B2、ADR-0072）の2系統が併存していた。
   - 手続き的ループでは Sub-step B1（Poset 葉ロールアップ）が Sub-step B2（`subject_others`）のコストを比較せずに常に先行実行され、かつ保持兄弟間の厳格非対称ガード（ADR-0008 `strictAsymmetry`）や `focus: 'mid'` の複数変動保有（`D_LOOK`, `F_WORK`）を考慮していなかったため、現場の中核当事者が `TEAM_WORK` へ吸収される一方、`focus: 'low'`・スコア `0.012` の周辺発注組織（`ORG_TOBU_OF`）が単独レーンを占有していた。
2. **Stage 2 の 1枚カード `suppress` 誘導による「幽霊レーン」発生と LLM 反復の浪費（`RM-ARCH-02`）**:
   - ADR-0072 で「中間フェーズは `K_pre` 列を実名保持し、最終フェーズで周辺主体を集約する」設計へ移行した後も、Stage 2（`granularityRefinement.ts`）に旧設計の `suppress`（1枚カードレーンの非表示化）ヒントと操作が残存していた。
   - その結果、唯一のカードが `suppressedCards` に入った主体（`ORG_SUB`）が「`analysis.entities` には存在するが `visibleSchema.lanes` には存在しない幽霊レーン」となって列数計算を狂わせ、さらにスコア改善 `+0.001` のためだけに Stage 2 の全文 LLM 推論1回（約30秒）を消費していた。
3. **Stage 3 における未割当イベント（`unassigned`）の責務分散と取り残し（`RM-ARCH-03`）**:
   - カード間接続専用の `proposeVTAConnections` が未割当イベント（`E11`, `E18`）に対して早計に `review_conn_*` を保存する一方、本来の担当である後続の `proposeChainRepair` では LLM が主体 `-` の `before` 関係のみを返しても検証エラーにならず、`E18（中継見張員配置未確認）` が未割当のままキャンバス未投影で終了していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **条件分岐の継ぎ足しではなくアーキテクチャ単純化で解決すること**: 二重の統合ロジックや表示層での擬似レーン削除を撤去し、単一の宣言的モデルへ集約して保守性と予測可能性を高める。
- **ADR-0067 の Stage 3 高速スキップ最適化の維持**: `unassigned = 0` かつ連結済みのグラフで `proposeChainRepair` を完全スキップできる実行順序（`proposeVTAConnections` → `proposeChainRepair`）を壊さない。
- **既存データ互換性と計算速度**: 保存済みプロジェクトの `suppressedCards` 互換を維持し、最終フェーズの分枝限定探索は $n \le K_{\text{pre}} \le 12$（最大 $2^{12} = 4,096$ 状態、1ms 未満）で決定論的に完結させる。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A（対症療法パッチ）**: 手続き的 Sub-step B1 に個別ガード条件を4つ追加し、`autoConnectVTA` の実行順序を `chain.repair` 先行へ入れ替える。
  - *却下理由*: 二重エンジン構造が残り B1 と B2 の大域コスト比較が行えないうえ、`chain.repair` 先行により未接続グラフ全体への重複 LLM 推論が発生する。
- **選択肢 B（採用：単一ソルバーへの統合 ＋ Stage 2 `suppress` 廃止 ＋ `chain.repair` 完了条件への一元化）**:
  - 手続き的 Sub-step B1/B2 ループを撤去して `solveOptimalSubjectRetention` 1系統へ統合し、Stage 2 の `suppress` 生成を廃止、Stage 3 は順序を維持したまま `chain.repair` の既存修復ループ完了条件で `unassigned` 網羅を保証する。

## 4. 決定事項 (Decision Outcome)

1. **主体統合エンジンの `solveOptimalSubjectRetention` への完全一本化（`RM-ARCH-01`）**:
   - `consolidatePeripheralSubjectsToOthers` から手続き的な Sub-step B1 / B2 ループを撤去し、最終フェーズでも `solveOptimalSubjectRetention`（`effectiveLimit = K_post`, `allowSubjectOthers: true`）を直接呼び出し、得られた `mergeTargetById` を `foldEntitiesIntoTargets` で一括適用する。
   - クラスタ内 `mergedFrom` を含むペアワイズ `evaluateMergeGuard`、保持兄弟間の `strictAsymmetry`（ADR-0008）、`:loss` 被災当事者保護、および直接変動保有アクター保護を単一ソルバー内で一元適用する（なお `focus === 'low'` の1枚カード主体で共有イベントが既に他の保持実名レーンに表示されている場合は周辺候補として許可する）。
   - 統合された主体のランキングエントリからは古い `mergeBlockedReason` をクリアし、診断上の矛盾表示を防止する。
2. **Stage 2 粒度反復における `suppress` 誘導・新規生成の廃止（`RM-ARCH-02`）**:
   - `granularityRefinement.ts` のシステムプロンプト・ボトルネックヒント・`applyRefinementOps` から新規 `suppressedCards` の生成を撤去し、1枚カード周辺主体の整理を最終フェーズの主体集約へ一本化する（既存保存データの `maintainPresentation` 互換は維持）。
3. **Stage 3 `chain.repair` の未割当網羅検証と AI 診断監査強化（`RM-ARCH-03`）**:
   - `chainRepairService.ts` の `repair` ループに `diag.unassigned` 網羅チェックを導入し、未割当イベントに対して `[割当追加]` も `[要確認]` も出力されていない場合は既存のターゲット修復パス（`repair = 1`）を自動作動させる。
   - `autoConnectionService.ts` にて、後続の `chain.repair` で主体割当（または `[要確認]` 整理）が完了したイベントに対する Stage 1 由来の陳腐化した `review_conn_*` を自動除去する。
   - `aiDiagnostics.ts` の `Silent Exclusions` に最終残存 `unassigned_events` を出力し、また `## 1. 題目` 直下の表題段落を未参照危険語フラグから除外する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 主体統合の意思決定ロジックが単一の分枝限定ソルバーに統一され、手続き的重複コードが大幅削減されると同時に、Poset ロールアップと `subject_others` の大域コスト比較により `D_LOOK`・`F_WORK` 等の現場当事者が確実に保持され、`ORG_TOBU_OF`・`ORG_SUB` 等の周辺組織が優先集約される。
  - Stage 2 での幽霊レーン発生と微差 `suppress` のための余分な LLM 通信（1回約30秒）が削減される。
  - 重要事象（`E18: 中継見張員配置未確認` 等）が `before` のみで未割当放置される抜け穴が塞がり、万一未割当が残った場合も AI 診断 v2.0 の `unassigned_events` で即座に検知できる。
- **トレードオフ・考慮事項**:
  - `diag.unassigned` を LLM が初回パスで無視した場合に限り `chain.repair` 内で軽量な対象行修復通信が1回追加発生するが、未投影による重要事象欠落の防止を優先する。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`, `src/tools/vta/features/vta/utils/subjectRanking.test.ts`
  - `src/tools/vta/services/generation/granularityRefinement.ts`
  - `src/tools/vta/services/generation/chainRepairService.ts`, `src/tools/vta/services/generation/chainRepairService.test.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/generation/autoConnectionService.test.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`, `tests/vta/aiDiagnostics.test.ts`
