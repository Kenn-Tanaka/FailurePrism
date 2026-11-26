# ADR-0088: 孤立集合受動ハブの修復・2段階統合の凸負荷加法保存則・および `subject_others` 推移遮断ポリシー

- **Status**: Accepted（第4節2項の葉展開 `applyCandidatesRaw` および固定 `'subject_others'` ID 前提は [ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md) により内容アドレス複合主体森へ発展置換）
- **Date**: 2026-11-25
- **Target Components**:
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts` / `public/prompts.json` (`event-ledger-23`)
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/features/vta/utils/presentation.ts`
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
- **Related Requirements / ADRs**: ADR-0010, ADR-0011, ADR-0082, ADR-0084, ADR-0087

---

## 1. コンテキストと課題 (Context & Problem Statement)

診断トレース `extract_full_1795574977103_xrrp`（東武鉄道日光線新鹿沼駅構内 列車触車事故、最細粒度 13 列 → 最終 8 列／目標 7 列）の診断およびコード監査から、以下の構造的不整合が確認された。

1. **孤立した集合受動イベント（`E11: 先行列車通過 [A4:affected]`）による上位ハブ `A4` の親子並立**:
   - `A4（除草薬散布作業班）` の配下に 8 名の実働下位主体が抽出済みである一方、図表見出し段落 `source_1/p47` が `E11（A4:affected、関係接続 0 件）` として抽出された。
   - ADR-0087 の受動被覆検査は `target`/`intended_recipient` 限定かつ同一イベント内の下位共起（`E_dir(H) = ∅`）のみを対象としていたため、`E11` が `softIssues` をすり抜けて `A4` が 1 カードの孤立成分（`成分=2`）となり、子レーンと横並びで残存した。
   - また、`p47` のような配置図・背景説明のみの段落に対し、`applyLedgerRepair` が `[イベント] → [整理] background` への移管を許可していなかったため、下位主体割当を強制するとハルシネーションを誘発するおそれがあった。
2. **2段階統合（`M2, M3 → P1`）における中間 0 イベントハブの Poset バイパスと凸意味負荷の二重計上**:
   - `projectPartitionToSchema` が新規発見グループ `group_中継見張_待避作業員群` を登録する際、葉主体（`A9, A10, A12, A13`）のみを子として `discoverConservativeParent` を呼んでいたため、2段階統合元の中間ハブ `A8（中継見張員）`・`A11（待避作業員）` が `group_*` と比較不能のまま `stage3_hc_prune` 扱いとなっていた。
   - 一方、0 イベントハブを安易に `excluded: undefined, mergedInto: group_*` へ変更すると、`getDrilldownSubEntities` で空の 0 カードサブレーンが露出したり、`splitEntitiesLocally` で幽霊主体が復活する不変条件違反を招く。
   - さらに `applyCandidatesRaw` が 2 段階統合 `P1(A8, A11 -> group: 0.28)` の `perSourceCost` をハブ数（2）で割って葉主体（4）全員へ `Math.max` 適用していたため、凸負荷 $\phi(c)$ が 2 倍に過大計上（または前段コストが消失・タダ乗り）されていた。
3. **`subject_others` の Poset 推移包含による未統合被災子孫への誤照合と診断 `parents` 不整合**:
   - 雇用親 `A3（下請会社）` を `subject_others` へ集約した際の保守的拡張 `A3 ≺ subject_others` により、推移律から未統合の `:loss` 被災レーン `A14` が `subject_others` の子孫となった。`participatesViaPoset`・`resolveCardsForRelationEndpoint`・`revertConsolidation` に `subject_others` 境界ガードがなかったため、推移フォールバックで誤照合し得る状態だった。
   - また `aiDiagnostics.ts` が `parents` に旧 `entity.parentEntityIds` のみを参照していたため、保守的拡張された `subject_others` / `group_*` が `ancestors` にのみ現れていた。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **事実性原則と非アドホック原則の維持**: 図表段落からの根拠なき下位主体推測を強制せず、純粋 Poset・グラフ次数（`[関係]` 未接続）のみで孤立集合受動イベントを検知し、必要時は `[整理]` への安全な退避を許すこと。
- **凸負荷の加法保存則と OLAP / 局所分割不変条件の両立**: 多段統合でも $\sum \phi(\text{next}) = \sum \phi(\text{prev}) + \Delta L$ を厳密に満たし、かつ `subjectRanking.ranks` 上の 0 イベントハブ `excluded: true` 不変条件を壊さずに Poset 連鎖と OLAP ドリルダウンを整合させること。
- **合成周辺バケットの推移境界分離**: `subject_others` の保守的親発見による既存 Poset 保存を維持しつつ、明示統合（`mergedFrom`）以外の未統合子孫へイベント・カード解決を推移拡大させないこと。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A: 0 イベントハブにも `mergedInto` を設定し、`subject_others` には `discoverConservativeParent` を使わない**
  - *却下理由*: `splitEntitiesLocally` で 0 カード主体が復活する回帰を招くほか、`subject_others` の Poset 保存（ADR-0087）を後退させる。
- **選択肢 B（採用）: 孤立非 `:actor` ハブ検知＋安全 `[整理]` 退避、2段階凸負荷加法保存＋0イベントハブ透過OLAP展開、および `subject_others` 推移境界ガード**
  - 純粋グラフ条件で孤立集合イベントを修復対象化し、`applyLedgerRepair` で未参照イベントの `[整理] background/excluded` 移管（連動する `[仮判定]`/`[判定]`/`[表現]` の自動整理付）を許可する。
  - `projectPartitionToSchema` では全実働子孫が包含される極大 0 イベントハブを `discoverConservativeParent` へ接続しつつ `ranks` の `excluded: true` を維持し、`getDrilldownSubEntities` 側で `excluded` 0 イベントハブを実働子孫へ透過展開する。
  - `applyCandidatesRaw` を増分凸負荷 $\Delta L$ の葉主体均等加算へ統一し、`subjectPoset.ts`・`subjectRanking.ts` で `subject_others` の Poset 推移フォールバックを遮断する。

---

## 4. 決定事項 (Decision Outcome)

1. **孤立集合受動イベント検知と `[整理]` 安全退避（`eventLedger.ts` / `eventPrompts.ts` `event-ledger-23`）**:
   - `inspectLedger` は、2 名以上の実働子孫を持つ非 `:actor`・非帰結の上位ハブが `[関係]` 未接続かつ外部共同関与者なしの非 `:actor` イベントを未カバーで持つ場合を `poset_ancestor_passive_target` の `softIssues` として検知する（因果連鎖に接続された法人資産損害は誤検知しない）。
   - `applyLedgerRepair` は、`[関係]`・`[共有カード]`・`[帰結]` から一切参照されていない修復対象 `[イベント]` 行について、同一 ID の `[整理] background` または `excluded` 行への置換を許容し、連動する `[仮判定]`・`[判定]` 行および `[表現]` のイベント参照を整合的に除去する。
   - `SUBJECT_FOCUS_POLICY`（`event-ledger-23`）および `public/prompts.json` に `:affected`・配置図段落の扱い（`[整理] background` または対象イベントへの参照併記）を明記した。
2. **2段階統合の凸負荷保存と中間 0 イベントハブの Poset・OLAP 統合（`laneConsolidationOptimizer.ts` / `presentation.ts`）**:
   - `applyCandidatesRaw` で 1 候補による増分凸負荷 $\Delta L$ を算出し、実際に移動した葉主体集合（`newlyMovedFineIds`）の既存負荷へ $\Delta L / |\text{newlyMovedFineIds}|$ を加算して $\phi^{-1}$ で記録することで、多段統合時の二重計上と負荷消失（タダ乗り）を解消した。
   - `projectPartitionToSchema` で全実働子孫が同一発見バケットへ統合された極大 0 イベントハブ（`A8, A11` 等）を `discoverConservativeParent` の子として接続しつつ `subjectRanking.ranks` 上の `excluded: true` を保持し、`getDrilldownSubEntities` で非実体化 `excluded` 0 イベントハブを実働子孫へ透過展開する。
3. **`subject_others` 推移境界ガードと診断 `parents` 同期（`subjectPoset.ts` / `subjectRanking.ts` / `aiDiagnostics.ts`）**:
   - `participatesViaPoset`・`resolveCardsForRelationEndpoint`・`revertConsolidation`（`viaPoset`）において、直接一致および `mergedFrom` 一致を優先した上で、`subject_others` を端点とする Poset 推移フォールバックを遮断する。
   - `aiDiagnostics.ts` の `parents` 出力を「明示親 ∪ `poset.getImmediateParents`」とし、多軸明示親と保守的発見親（`subject_others`・`group_*`）の両方を `parents` と `ancestors` で一貫表示する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `E11（A4:affected）` のような図表・集合状況イベントによる親ハブ孤立・親子並立が防がれ、事実性を保ったまま下位再割当または `[整理] background` へ整理される。
  - 2 段階統合のスコア評価が厳密に加法保存則を満たし、中間 0 イベントハブも Poset・OLAP ドリルダウン・手動分割で破綻なく扱える。
  - `subject_others` へ周辺親組織（`A3`）を畳んでも、未統合の `:loss` 被災レーン（`A14`）への意図しない推移一致が遮断される。
- **トレードオフ・考慮事項**:
  - `subject_others` を含む既存単体テストは `mergedFrom` 経由で解決されるため影響を受けないが、将来 `subject_others` 自体へ新規イベントを直接付与した上で子孫側へ解決したい場合は明示的な関与・統合履歴が必要となる。
- **影響ファイル**:
  - `src/tools/vta/features/vta/utils/eventLedger.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `public/prompts.json`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/features/vta/utils/presentation.ts`
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/services/llm/prompts.test.ts`
  - `src/tools/vta/features/vta/utils/ledgerValidation.test.ts`
  - `src/tools/vta/features/vta/utils/subjectPoset.test.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
  - `docs/adr/0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md`
  - `docs/adr/README.md`
