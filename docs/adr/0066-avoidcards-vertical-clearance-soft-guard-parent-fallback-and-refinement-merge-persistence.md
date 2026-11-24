# ADR-0066: avoidCards 垂直離隔制御・ソフトガード親組織フォールバック・粒度反復明示統合永続化および事後除外前未割当保護

- **Status**: `Accepted`
- **Date**: `2026-11-21`
- **Target Components**: `VTA Edge Routing`, `VTA Layout Engine`, `VTA Subject Consolidation`, `VTA Granularity Refinement`, `VTA Granularity Score`, `VTA Relation Contract`, `VTA AI Diagnostics`
- **Related Requirements / ADRs**: [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0046](./0046-cross-lane-wire-clearance-and-diagnostics-lineage.md), [ADR-0048](./0048-resilience-outcome-separation-and-avoidcards-clearance.md), [ADR-0050](./0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0062](./0062-intra-lane-detour-channel-separation-poset-alias-resolution-and-relation-lineage.md), [ADR-0065](./0065-explicit-merge-slot-preservation-uncompressed-convergence-and-preliminary-ref-filtering.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

東京国際空港C滑走路衝突事故シナリオ（イベント63件・カード100枚・エッジ145本、モデル `openrouter/google/gemini-3.8-flash`）の AI 診断トレース（`2026-11-21T00:22:45.808Z`）において、DOM 実測高さ反映後の幾何監査および各パイプライン出力に以下の構造的不整合が確認された。

1. **`avoidCards` 迂回経路での垂直幹線 0px 重畳 (`LAYOUT_CLOSE_VERTICAL_EDGES`)**:
   - ADR-0048 により `avoidCards`（`edgeRouting.ts`）へ `HorizontalBand`（`extraAvoidBands`）は導入されていた一方、垂直幹線の占有帯（`VerticalBand`）回避および `outChannelOffset` / `inChannelOffset` の引き渡しが未実装であった。
   - `getOrthogonalStepPath`（`layout.ts`）が `avoidCards` 呼び出し時に `sourceMargin` を渡さず `targetMargin` からも `inChannelOffset` を落としていたため、`pickConflictAwareCorridorPath` の Phase B（`outOffsets` / `inOffsets` 探索）が全反復で同一の X 座標を生成し、`shared:E29:card_21:card_84` と `relation:R11` が `0px` 重複していた。
   - また、ノード本体の背後方向への折り返しを防ぐ保護や、過密時に垂直帯のみで全経路が閉塞した場合のカード回避フォールバックも不足していた。
2. **ソフト Merge Guard 発動時の保持済み親組織無視と `subject_others` 誤配属**:
   - `resolveParentTarget`（`subjectRanking.ts`）が `evaluateMergeGuard` 拒否時に `targetId: undefined` のみを返していたため、保持枠が上限に達し（`retainedIds.size >= effectiveLimit`）、かつ `strictAsymmetry: false`（ソフトガード、例: 変動事象に触れる `transfer` / `dependency`）である場合に、`rankSubjects` が「親組織なし」の分岐へフォールバックし、保持中の親組織（`A_JCG`）を持つ `A_COMM_STA` を `subject_others` へ誤配属していた。
3. **粒度反復（`granularityRefinement.ts`）における `explicitMerges` 非永続化と `forceRetained` 非トランザクション更新**:
   - `applyRefinementOps` が反復ごとに局所変数 `const explicitMerges = new Map()` を新規作成しており、`refineGranularity` 側でも採用済み `explicitMerges` を保持・引き継ぎしていなかった。
   - この結果、`#1` で採用した `merge:A_TRAIN_B->A_CAP_B` が `#2`（`merge:A_TWR_E->A_ATC`）で `revertConsolidation` 実行時に消失し、レーン数削減（`7 -> 8`）と `C1` 低下を引き起こして正当な統合が却下されていた。また、不採用反復での `forceRetained` 変更が後続へ漏洩し得る状態にあった。
4. **`filterPostOutcomeScope` による帰結前・未割当イベントの誤除外 (`granularityScore.ts`)**:
   - `filterPostOutcomeScope` が `nextNodes`（カードを持つノード）からのみ `initialKeptEventIds` を収集していたため、帰結前に発生した主体未割当イベント（`unassignedEventIds`）まで一律に `ignored: true, ignoreReason: 'post_outcome'` へ書き換えられ、`disp_post_*` 誤記録および `unassignedEventIds` の空化（`67 -> 63` 件へ予期せず減少）を招いていた。
5. **契約文言の曖昧さと AI 診断トレースの観測ノイズ (`relationContract.ts`, `aiDiagnostics.ts`)**:
   - `RELATION_CONTRACT_PROMPT` が同一主体 `dependency` 禁止の例として同一組織統合（`A_JCG → A_JCG`）のみを挙げており、同一人物の連続行動（`A_COP_A → A_COP_A`）に対する抑止が不明確だった。
   - `detectTriggerEntityIds` が `[REPAIRED]` 済み異常の後に未修復異常を処理していたため `entity_lineage` 先頭5枠が修復済み関係に占有され、また `traceEntityLineage` が内容未変化の `ledger.validation` 行にも重複 `MUTATED` を記録していた。さらに `LAYOUT_CLOSE_VERTICAL_EDGES` / `LAYOUT_CLOSE_HORIZONTAL_EDGES` に座標・両端カード詳細が出力されていなかった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **競合なしベースラインの不変性**: 既存の干渉しない通常パスおよびカード衝突なし経路の座標は一切変化させない。
- **カード衝突回避の絶対優先**: `VerticalBand` 回避によって `avoidCards` が行き詰まった場合は垂直帯制約のみを外して再探索し、カード貫通パスへの退行を絶対に防ぐ。
- **組織包含階層と非対称保護の両立**: 厳格非対称（`strictAsymmetry: true`）の独立維持ルールは堅持しつつ、枠不足で独立保持できないソフトガード主体は `subject_others` ではなく保持中の親/祖先組織へ統合する。
- **台帳契約検証テストとの整合**: 同一主体 `dependency` の LLM 修復要求ルール（`inspectLedger` での issue 検出）は変更せず、プロンプト明文化のみで生成時誤用を抑止する。
- **反復状態のトランザクション性**: `granularityRefinement` の採用判定前に `forceRetained` と `explicitMerges` を複製し、`improved === true` の場合のみ確定する。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: `JUNCTION_APPROACH_MARGIN` を拡大し、`inspectLedger` で同一主体 `dependency` を自動 `before` 降格する**
  - *却下理由*: `JUNCTION_APPROACH_MARGIN` 変更は全ドットの既存接続座標を移動させ既存テストと不整合になる。また `inspectLedger` の自動降格は既定の修復契約（`ledgerValidation.test.ts`）に反する。
- **選択肢2 (採用): `avoidCards` へ `VerticalBand`・`sourceMargin`/`targetMargin`・段階的フォールバックを導入し、ソフトガード親フォールバック・`explicitMerges` 永続化・未割当イベント保護・契約明文化および診断観測改善をそれぞれ責務境界に沿って実装する**
  - *利点*: 競合のない既存経路や契約検証の不変条件を 100% 維持しながら、P1〜P3 の根本原因を局所かつ検証可能に解消できる。

---

## 4. 決定事項 (Decision Outcome)

1. **`edgeRouting.ts` / `layout.ts` における `avoidCards` 垂直離隔制御と幾何監査拡充 (P1-1 / P3)**:
   - `edgeRouting.ts` に `VerticalBand` と `AvoidCardsOptions` 拡張（`sourceMargin?`, `extraAvoidVerticalBands?`）を追加し、`xs` 候補点にカード左右外周 `±xMargin / ±(xMargin+14)` および帯境界 `minX - 1 / maxX + 1` を展開する。
   - 水平区間が端子背後の本体側へ折り返さない `crossesEndpointBody` を導入し、A\* 探索 `runSearch(true)` が解を得られない場合は `runSearch(false)` で垂直帯制約を外したカード回避フォールバックを行う。
   - `layout.ts` の `getOrthogonalStepPath` は側面接続時に `outChannelOffset` / `inChannelOffset` を `sourceMargin` / `targetMargin` へ転送し、`pickConflictAwareCorridorPath` は垂直占有帯 `avoidVerticalBands`（`isExemptSharedVerticalPortStub` 除外）を構築して Phase A（`corridorOffsetY: 0` 含む）および Phase B へ渡す。
   - `auditVTALayoutGeometry` の `closeParallelHorizontalEdges` / `closeParallelVerticalEdges` へ任意メタデータ（`targetA/B`, `sourceLaneA/B`, `targetLaneA/B`, `sourceIsDot*`, `targetIsDot*`, `coordA/B`, `overlapMin/Max`）を付加する。
2. **`subjectRanking.ts` のソフトガード親組織フォールバックおよび連鎖統合ガード (P1-2)**:
   - `resolveParentTarget` が直接親・祖先・明示統合先での `!guard.allowed` 時に `fallbackTargetId`（兄弟検査では設定しない）を返すよう拡張し、`rankSubjects` は枠上限時のソフトガード分岐で `fallbackTargetId` を優先して `subject_others` 落ちを防止する。
   - `explicitMerges` 適用ループで `targetId` が `explicitSourceIds` に含まれる場合は `retainedIds.add(targetId)` を抑止し、Map 挿入順非依存の多段統合整合性を保証する。
3. **`granularityRefinement.ts` の反復間 `explicitMerges` 永続化と状態複製 (P1-3)**:
   - `applyRefinementOps` の第6引数へ `explicitMerges: Map<string, string> = new Map()` を追加し、`split` 適用時に `explicitMerges.delete(op.targetId)` を実行する。
   - `refineGranularity` は `forceRetained` と `explicitMerges` を反復前に複製して評価し、`if (improved)` の場合のみ両者をコミットする。
4. **`granularityScore.ts` の `filterPostOutcomeScope` 未割当イベント保護 (P2)**:
   - `nextAnalysis.unassignedEventIds` のうち帰結前（`sourceOrder <= maxOutcomeOrder` または `EventTimeDAG` 上で帰結前）またはレジリエンス回復に該当するイベントを `keptEventIds` に含め、既に `ignored` のイベントを上書き・重複 `disp_post_*` 化しない。
5. **`relationContract.ts`・`public/prompts.json`・`aiDiagnostics.ts` の明確化と観測性向上 (P3)**:
   - `RELATION_CONTRACT_PROMPT` および `public/prompts.json`（`normalization`, `connectionProposal` 双方）に同一人物・同一主体の連続行動（例：`A_COP_A → A_COP_A`）でも `before` を使う旨を明記する。
   - `aiDiagnostics.ts` の `detectTriggerEntityIds` で未修復異常を `[REPAIRED]` より先頭配置し、`traceEntityLineage` は前回と同一内容の `ledger.validation` 行で重複 `MUTATED` を出力しないよう署名比較する。また近接平行エッジ異常の構造化 `geometry` を生成・Markdown 出力する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `avoidCards` 発動時も `EDGE_VERTICAL_CLEARANCE_X`（`14px`）以上の離隔が確保され、DOM 実測高さ反映後に再顕在化していた `0px` 平行垂直線重複が解消される。
  - 枠上限時のソフト Merge Guard 対象（`A_COMM_STA` 等）が保持中の親組織へ適切に統合され、意味のない `subject_others` バケット生成が抑止される。
  - 複数反復の主体 `merge` が累積適用されるようになり、`#1` の統合を維持したまま `#2` 以降の組織ハブ統合が進む。
  - `filterPostOutcomeScope` が未割当イベントや既存除外状態を破壊しなくなり、後続監査・診断件数の一貫性が保たれる。
  - AI 診断パッケージが未修復異常のリネージおよび近接エッジの精密座標を直接提示できる。
- **トレードオフ・考慮事項**:
  - `avoidCards` のグリッドに `±14` および `extraBandXs` が加わるため探索頂点数はわずかに増えるが、交差回避対象がある場合（Phase A 以降）のみ作動するため通常描画コストへの影響はない。
  - 同一人物の `dependency` 契約表現の追加はプロンプト指示の強化であり、`inspectLedger` 側の契約検証と修復要求フロー（`ledgerValidation.test.ts`）は従来どおり維持される。
- **影響を受けるファイル・テスト**:
  - [edgeRouting.ts](../../src/tools/vta/features/vta/utils/edgeRouting.ts)
  - [layout.ts](../../src/tools/vta/features/vta/utils/layout.ts)
  - [subjectRanking.ts](../../src/tools/vta/features/vta/utils/subjectRanking.ts)
  - [granularityRefinement.ts](../../src/tools/vta/services/generation/granularityRefinement.ts)
  - [granularityScore.ts](../../src/tools/vta/services/generation/granularityScore.ts)
  - [relationContract.ts](../../src/tools/vta/features/vta/utils/relationContract.ts)
  - [public/prompts.json](../../public/prompts.json)
  - [aiDiagnostics.ts](../../src/tools/vta/services/diagnostics/aiDiagnostics.ts)
  - [edgeRouting.test.ts](../../src/tools/vta/features/vta/utils/edgeRouting.test.ts)
  - [subjectRanking.test.ts](../../src/tools/vta/features/vta/utils/subjectRanking.test.ts)
  - [granularityRefinement.test.ts](../../src/tools/vta/services/generation/granularityRefinement.test.ts)
  - [granularityScore.test.ts](../../src/tools/vta/services/generation/granularityScore.test.ts)
  - [aiDiagnostics.test.ts](../../tests/vta/aiDiagnostics.test.ts)
  - [docs/adr/README.md](./README.md)
