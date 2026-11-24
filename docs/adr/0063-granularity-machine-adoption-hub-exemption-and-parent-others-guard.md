# ADR-0063: 粒度反復の機械指標採否正規化・ハブ次数計算是正および上位組織単独の「その他の関係者」落ち防止ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-21
- **Target Components**: `VTA Granularity Refinement`, `VTA Granularity Score`, `VTA Subject Consolidation`, `VTA Relation Contract`, `VTA AI Diagnostics`
- **Related Requirements / ADRs**: [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0050](./0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0058](./0058-granularity-score-global-rank-crossing-and-causal-reachability.md), [ADR-0059](./0059-granularity-refinement-same-iteration-llm-score-cancellation.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港衝突事故シナリオ（イベント48件・カード72枚）の AI 診断トレース（`2026-11-20T19:41:21.040Z`）を解析した結果、以下の構造的不整合が判明した。

1. **`granularity.refinement #1` における `scenarioScore` 混合による `C3` 重み圧縮と正当修正の誤棄却**:
   - ADR-0059 では同一反復の LLM 主観スコア（`C2` / `C4` / `scenarioScore`）を比較の両側に適用して相殺させる方針としたが、`mNext.c3` と `mBest.c3` に `0.4 * m.c3 + 0.6 * scenarioScore` を適用した総合スコア `nextScore >= comparableBestScore` を採否条件に残していた。
   - このため定数項 `0.6 * scenarioScore` は相殺されても **係数 `0.4` が残り**、純機械指標 `C3` の実効重みが `0.25 → 0.10`（`w5 = 0.15` 未満）へ圧縮されていた。
   - 同時に、`granularityScore.ts` の `maxDegree` がレーン内の自動直列タイムライン骨格線（`direction: 'sequential'`）および全因果が収束する帰結ノード（`outcomeNodeIds`）を区別せず次数に計上していたため、有効な `add_relation` 1本の追加で `C5` が `-0.05` 低下し、純機械スコアが `0.782 → 0.797` へ改善したにもかかわらず `0.764 < 0.765` で 5件の因果修正（`add_relation`×3, `modify_relation`×2）が不採用となった。
2. **直接イベント 0件の親組織（`A_JAL` 等）の単独 `subject_others` 落ち**:
   - 子主体が全員上位保持された直接関与イベント 0件の上位組織（`A_JAL`）に対し、`promoteConsolidationHubs` の超過子孫条件（`>= 2`）が不成立となった後、`rankSubjects` がイベント参加有無を確認せず `subject_others` へ割り当てていた。さらに、`subject_others` へ入る実体主体が 1件のみで保持枠に空きがある場合でも匿名バケット「その他の関係者」へ包み替えていた。
3. **初回台帳出力時の `dependency` 同一主体・非関与先主体と診断表示の区別**:
   - 同一組織ID内での連携に `dependency`（別主体必須）が出力され修復ラウンドが発動するケースについて、`RELATION_CONTRACT_PROMPT` 側の明示を抑止・強化した。
   - また、後続の `ledger.validation` で `issues: 0` に修復完了した初回エラーに対し、`aiDiagnostics.ts` が未修復エラーと区別できるよう `[REPAIRED]` 接頭辞を付与する必要があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- ADR-0059 の「採否は機械指標と図構造の改善のみで決まる」という原則を、重み圧縮の歪みなく厳密に実現すること。
- 非帰結カードに対する過密ハブ抑止（`maxDegree > 4`）や ADR-0050 の同点不採用ガードは維持すること。
- `SubjectPoset` および `subjectRanking.originalEntities` に包摂親組織を保持したまま、実体イベントを持たない幽霊 `subject_others` の生成を防ぐこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: `scenarioScore` の混合比率（`0.4 / 0.6`）だけを調整する**
  - *課題*: 比率が残る限り `C3` と `C5` の重みバランスが LLM 応答の `シナリオ` 評価有無で変動する構造的歪みが残る。
- **選択肢2 (採用): 採否ゲートを歪みのない `nextMachineScore` vs `comparableMachineBaseline` に一本化し、`maxDegree` から直列骨格線・帰結収束を除外し、0件親組織の `subject_others` 混入を防ぐ**
  - *利点*: `nextScore`・`comparableBestScore` の表示/記録および `targetScore` 判定を保ったまま、機械指標の本来の重みで一貫した採否判定が行える。

---

## 4. 決定事項 (Decision Outcome)

1. **`granularityRefinement.ts` の採否判定正規化**:
   - `improved` の判定基準から `nextScore >= comparableBestScore` の混合スコア依存を外し、純機械スコア `nextMachineScore` と `comparableMachineBaseline` の比較（`machineNotDegraded` かつ `nextMachineScore >= comparableMachineBaseline - 1e-9`、かつ `machineStrictlyImproved || topologyImproved`）へ統一する。
2. **`granularityScore.ts` の `maxDegree` 是正**:
   - 隣接ノード集合の構築時にレーン内直列順序線（`e.direction === 'sequential' && !e.relationId`）を除外し、非帰結ノードの次数最大値（非帰結ノードが存在しない場合のみ全ノード最大値）で `maxDegree` を計測する。
3. **`subjectRanking.ts` の 0件親組織・単独 `subject_others` ガード**:
   - オーバーフロー候補のうち直接関与イベントを持たない主体（`!participatingEntityIds.has(id)`）は `subject_others` へ入れず `excludedIds` へ回す（`subjectPoset` / `originalEntities` の階層情報は保持）。
   - `othersId` への統合対象が 1件のみでかつ `retainedIds.size < effectiveLimit` の場合は、`subject_others` を生成せず実名主体のまま `retainedIds` に保持する。
4. **`relationContract.ts`（`public/prompts.json` 同期含む）および `aiDiagnostics.ts` の改善**:
   - `RELATION_CONTRACT_PROMPT` に集約済み同一主体ID間の `before` 使用ルールと割当済み主体参照ルールを明記する。
   - 後続 `ledger.validation`（同一 `runId`）で `issues.length === 0` となった検証指摘には `[REPAIRED] ` を付与して区別する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `scenarioScore` 出力時に `C3` の改善が `0.4` 倍に過小評価されて正当な `add_relation` 修正群が棄却される不具合が解消される。
  - 帰結ノードへの多方向収束や通常の直列タイムライン線による不当な `C5` 減点がなくなり、真に過密な非帰結ハブのみを抑制できる。
  - イベント 0件の上位親組織による幽霊「その他の関係者」レーンの生成と単独主体の匿名化が防止される。
- **トレードオフ・考慮事項**:
  - `RELATION_CONTRACT_PROMPT` 変更に伴い `public/prompts.json` の同期更新が必要となる（`prompts.test.ts` で自動検証済み）。
- **影響ファイル**:
  - [granularityRefinement.ts](../../src/tools/vta/services/generation/granularityRefinement.ts)
  - [granularityScore.ts](../../src/tools/vta/services/generation/granularityScore.ts)
  - [subjectRanking.ts](../../src/tools/vta/features/vta/utils/subjectRanking.ts)
  - [relationContract.ts](../../src/tools/vta/features/vta/utils/relationContract.ts)
  - [public/prompts.json](../../public/prompts.json)
  - [aiDiagnostics.ts](../../src/tools/vta/services/diagnostics/aiDiagnostics.ts)
  - [granularityRefinement.test.ts](../../src/tools/vta/services/generation/granularityRefinement.test.ts)
  - [granularityScore.test.ts](../../src/tools/vta/services/generation/granularityScore.test.ts)
  - [subjectRanking.test.ts](../../src/tools/vta/features/vta/utils/subjectRanking.test.ts)
  - [aiDiagnostics.test.ts](../../tests/vta/aiDiagnostics.test.ts)
  - [docs/adr/README.md](./README.md)
