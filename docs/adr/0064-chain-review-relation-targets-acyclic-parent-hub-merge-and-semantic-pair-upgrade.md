# ADR-0064: 連鎖補完「要確認」の関係ID解決・上位組織逆転マージ非循環化および1対1意味関係アップグレード採用ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-21
- **Target Components**: `VTA Chain Repair`, `VTA Subject Poset`, `VTA Subject Consolidation`, `VTA Granularity Refinement`
- **Related Requirements / ADRs**: [ADR-0010](./0010-subject-poset-dag-and-semantic-inclusion-hierarchy.md), [ADR-0012](./0012-chain-repair-delta-validation-and-relation-sanitization.md), [ADR-0050](./0050-parent-hub-consolidation-refinement-strict-adoption-and-outcome-preliminary-exclusion.md), [ADR-0056](./0056-gateway-retry-observability-cross-lane-geometry-trace-and-temporal-inversion-guard.md), [ADR-0059](./0059-granularity-refinement-same-iteration-llm-score-cancellation.md), [ADR-0063](./0063-granularity-machine-adoption-hub-exemption-and-parent-others-guard.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

羽田空港衝突事故シナリオ（イベント66→62件・カード89枚）の AI 診断トレース（`2026-11-20T21:00:05.494Z`）において、ADR-0063 による初回台帳一発通過・`subject_others` 消滅・`layout.audit` 0件が確認された一方で、下流パイプラインの以下 3つの構造的不具合が特定された。

1. **`chain-repair.validation` (`[要確認]`) における関係ID参照の拒否と不要な全文修復通信 (`chk_1`)**:
   - `proposalContext.ts` は `[全イベント]`・`[主体]` に加えて `[全関係]`・`[全カード]`・`[接続]` を連鎖補完プロンプトへ提示しているが、`applyChainDelta`（`chainRepair.ts`）は `a.events` と `a.entities` のみ照合していた。
   - このため冗長な既存関係 `R2` を指摘した正当な `[要確認]` 行 `chk_1` が `要確認の対象がありません` で棄却され、無駄な 8回目の全文修復 LLM 通信が発生していた。
   - さらに、`[要確認]` が同一デルタの `[関係追加]` 行IDを参照すると、`permanent = true` 本採用時に行IDが `'added_' + uuid` へ置換されてプレビュー通過後に例外化するリスクがあった。
2. **上位組織を下位ハブへ `merge` した際の `A_CAB_ORG` ⇔ `A_TWR_ORG` 親子循環とハブ昇格押し出し**:
   - 粒度反復 `#1` が親組織 `A_CAB_ORG`（国土交通省東京空港事務所）を子ハブ `A_TWR_ORG`（東京飛行場管制所）へ統合（`merge:A_CAB_ORG->A_TWR_ORG`）した際、`applyRefinementOps` が `isAncestor` 確認なしに `A_CAB_ORG.parentEntityId = 'A_TWR_ORG'` を書き込み（しかも `parentEntityId` 上書き後に `currentParents` を読んでいた）、`applyForceMergeTransition` も同等の無条件書き込みを行っていた。
   - 同時に `SubjectPoset.fromEntities` が `addRawEdge` ではなく `addEdge` を呼んでいたため、2本目の逆向き辺が `hasRawCycleCandidate` を立てずに捨てられ、直後に `poset.removeCycles()` を呼ぶ `eventLedger.ts` や `eventAnalysis.ts` でも常に `removedEdges: []` となり、`entities` 上の循環親参照が除去されなかった。
   - さらに `SubjectPoset` 構築時内部の `removeCycles()` 消費への対処に加え、`rankSubjects` の `promoteConsolidationHubs` が明示マージ元 `A_CAB_ORG` を親ハブ昇格させて無関係レーンを押し出す問題、`resolveParentTarget` および `consolidateSubjects`（`parentEntityIds` 複数形含む）の推移解決漏れも修正する必要があった。
3. **`granularity.refinement #2` における1対1意味関係昇格の不採用 (`rel_ref_M6, M7`)**:
   - 共有イベント未判定線（`shared:...` / `meaning: 'association'`）や同一レーン隣接直列線（`sequential`）を具体的な意味関係（`transfer` / `impact` / `dependency` / `mutual`）へ昇格させると、可視エッジが 1対1 で置換されて総エッジ本数が増えないため、`candVis.edges.length > bestVis.edges.length` のみを見ていた `topologyImproved` が同点機械スコアの改善を棄却していた。
   - 一方で単純な本数比較にすると、同一カードペアへの並列多重エッジ追加（単一エッジ契約違反）を誘発する恐れがあった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- `[要確認]` で既存・新規のイベント・主体・関係・カード・接続を漏れなく検証し、`permanent = false/true` の双方で一貫動作させつつ、`targets = '-'` や実在しないIDは確実に弾くこと。
- `SubjectPoset` は本来の意味論的包含階層（`A_TWR_ORG < A_CAB_ORG`）を非巡回 DAG として維持し、上位親から下位ハブへの統合は Poset 逆転ではなく `explicitMerges` と統合マップ推移閉包で表すこと。
- `ADR-0050` の同点 `before` 関係追加不採用ポリシーおよび単一カードペア単一意味関係契約を維持したまま、未判定線・直列線の意味関係への質的昇格を正しく採用すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢1: 不正IDの警告スキップ・単純本数比較で回避する**
  - *課題*: `permanent = true` 時の UUID 化不整合や `SubjectPoset` 循環残留、同一カードペアへの並列多重エッジ誤採用を解消できない。
- **選択肢2 (採用): デルタ行IDと永続変換を考慮した対象解決、`SubjectPoset` 構築時除去辺の引き渡し＋非巡回マージ・ハブ昇格除外、およびユニーク無向カードペア数による意味関係改善判定**
  - *利点*: プレビュー/本採用・OLAP ドリルダウン・統合解除（`revertConsolidation`）の完全な整合性と可逆性を保ったまま3課題を一括解決できる。

---

## 4. 決定事項 (Decision Outcome)

1. **`chainRepair.ts` の `[要確認]` 検証・依存選択拡張**:
   - `list` で要素トリミングと空文字除外を行い、`targetList.length === 0`（`targets === '-'`）を拒否する。
   - `validReviewTargetIds` にイベント・主体・統合前オリジナル主体・Posetノード・関係ID・カードID・処分ID・可視エッジID・および同一デルタ内の非確認行ID（`permanent = true` で UUID 化される行の参照維持用）を含める。
   - `selectChainDependencies` で `[要確認]` 行選択時に参照先の同一デルタ行も連鎖選択する。
2. **`subjectPoset.ts`・`subjectRanking.ts`・`granularityRefinement.ts` の非巡回マージおよび循環除去保全**:
   - `SubjectPoset.fromEntities` で `addRawEdge` を使用し、`fromEntities` / `fromData` 内の構築時 `removeCycles()` で除去したサイクル辺を `pendingRemovedCycleEdges` に保持して最初の外部 `removeCycles()` 呼び出しで返却する。
   - `applyRefinementOps`（`merge`）および `applyForceMergeTransition` では `currentPoset.isAncestor(target, into)` のとき親ポインタを上書きせず `explicitMerges` のみで統合し、`explicitMerges` 自身の相互循環も抑止する。
   - `rankSubjects` では `promoteConsolidationHubs` から `explicitMerges` のソース主体を除外し、`resolveParentTarget`（全2箇所の呼び出し）へ `explicitMerges` を渡して自身および祖先の統合先ハブを推移解決、さらに `mergeTargetById` を推移閉包化する。`consolidateSubjects` でも `parentEntityIds` 複数形を同期・自己参照除去する。
3. **`granularityRefinement.ts` の意味関係ペア純増判定と決定論的操作順**:
   - `applyRefinementOps` の関係操作を `remove_relation` → `modify_relation` → `add_relation` 順に適用する（同一 `kind`・端点の完全重複はスキップしつつ、既存の異なる `kind` 同士の追加契約は維持）。
   - `topologyImproved` で総エッジ本数の代わりにユニーク無向接続カードペア数およびユニーク無向意味関係カードペア数（`Boolean(e.relationId) && e.meaning !== 'association'`）の純増を比較し、1対1意味関係昇格は採用する一方、既に意味関係で接続済みのカードペアに対する同点並列重複エッジの追加は採否ゲートで棄却する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 既存の冗長関係 `R2` や新規提案関係を参照する正当な `[要確認]` が一発通過し、無駄な修復 LLM 通信が解消される。
  - 上位組織から下位ハブへの粒度統合でも `SubjectPoset`・`originalEntities`・`consolidatedEntities` の非巡回性が保たれ、無関係レーンの追い出しや `parentEntityIds` 残存も防がれる。
  - 共有未判定線や直列骨格線を具体的な意味関係へ昇格させる `add_relation` 修正が正当に採用されつつ、重複並列エッジや無意味な `before` は引き続き棄却される。
- **トレードオフ・考慮事項**:
  - `SubjectPoset.fromEntities` は構築直後の時点で DAG 化を保証しつつ `removeCycles()` の初回呼び出し時にのみ構築時の除去辺を返すため、呼び出し元が同じインスタンスに対して複数回 `removeCycles()` を呼ぶと2回目以降は空配列となる（`subjectPoset.test.ts` で仕様化）。
- **影響ファイル**:
  - [chainRepair.ts](../../src/tools/vta/features/vta/utils/chainRepair.ts)
  - [subjectPoset.ts](../../src/tools/vta/features/vta/utils/subjectPoset.ts)
  - [subjectRanking.ts](../../src/tools/vta/features/vta/utils/subjectRanking.ts)
  - [granularityRefinement.ts](../../src/tools/vta/services/generation/granularityRefinement.ts)
  - [chainRepair.test.ts](../../src/tools/vta/features/vta/utils/chainRepair.test.ts)
  - [subjectPoset.test.ts](../../src/tools/vta/features/vta/utils/subjectPoset.test.ts)
  - [subjectRanking.test.ts](../../src/tools/vta/features/vta/utils/subjectRanking.test.ts)
  - [granularityRefinement.test.ts](../../src/tools/vta/services/generation/granularityRefinement.test.ts)
  - [docs/adr/README.md](./README.md)
