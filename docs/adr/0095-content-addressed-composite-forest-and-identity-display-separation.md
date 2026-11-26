# ADR-0095: 主体の内部アイデンティティと表示名の完全分離・内容アドレス付き複合主体森（Content-Addressed Laminar Forest）・封印複合遷移および Poset 包含検証ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`subjectCompositeForest.ts`, `laneConsolidationOptimizer.ts`, `subjectRanking.ts`, `presentation.ts`, `eventAnalysis.ts`, `laneOrder.ts`, `subjectPoset.ts`, `vtaStore.ts`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0088](./0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md)（平坦分割投影を本ADRで更新）, [ADR-0089](./0089-two-stage-cohort-subgroup-consolidation-passive-guard-symmetry-and-post-loss-stop-scope.md)（先行グループ葉展開を本ADRで更新）, [ADR-0092](./0092-poset-preserving-manual-lane-force-merge-via-parent-discovery.md)（親主体IDその場流用・合成親アンラップを本ADRで更新）, [ADR-0094](./0094-partition-objective-collective-hub-coverage-and-candidate-peeling.md)

## 1. コンテキストと課題 (Context & Problem Statement)

大規模シナリオ（新鹿沼駅構内触車事故 `0u9b` および羽田空港C滑走路衝突事故 `bp8u`）の実データ検証と設計レビューを通じ、従来の主体レーン統合表現に以下の4つの構造的問題が特定された。

1. **非包含主体への不正吸収（`machine -> person` 等の主体の変質）**:
   - 従来のプロンプトおよび `parseLaneConsolidationTSV` は、`object_absorb` 等において Poset 包含関係（$u \prec T$）が成立しない実在個人（例: `M8: A_JA722A (machine) -> A_CAPT_A (person)`）への吸収を許容していた。機械 $M$ と人物 $P$ を統合する場合は人間・機械複合システム $S$ として新たな複合主体を構築すべきであり、片方への吸収は主体の破壊となる。
2. **複合主体の事後変更・葉平坦化による木構造の喪失と親主体の逆転（`A_JAL` 逆転）**:
   - 従来の `parseLaneConsolidationTSV` と `projectPartitionToSchema` は多段統合（例: `0u9b` の `M3, M4 -> M5`）を単一階層 `Map<leafId, bucketId>` に平坦化し、作成済み複合主体への構成要素追加・部分分離を許容していた。さらに投影時に `|D(h)| <= |B|`（等号を含む）で 0 イベントハブ $h$ を仮想グループの下位子ノードとして接続していたため、`bp8u` において B機全11葉を包摂する上位法人 `A_JAL (日本航空株式会社)` が `group_B機全体` の**子主体へ逆転接続**される不整合が発生していた。
3. **実在主体 $T$ へのその場吸収による内部アイデンティティの変質**:
   - 実在する上位主体 $T$ が自分の Poset 子孫 $C_1, C_2, \dots$ を段階的に吸収する際、従来は統合後も内部 ID を `T` のまま流用していた。しかし子孫を吸収した状態は元の単体主体 $T$ とは異なる複合範囲を表すため、VTA 図上の表示名として $T$ の名称を再利用しつつも、内部的には別主体（新たな複合 ID）として厳密に区別する必要がある。
4. **「その他の関係者」のハードコード文字列 `'subject_others'` への依存**:
   - 周辺主体集約枠が固定文字列 `'subject_others'` にハードコードされており、統合内容に応じた一意な状態識別や一般複合主体との統一的扱いを阻害していた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **最細度主体（Atomic Subject）の単一レーン所属保証**: いかなる統合・再構築・分割遷移を経ても、すべての関与最細度主体 $u \in U$ が複数レーンに重複出現したり欠落したりしないこと（$\bigsqcup_{R \in \text{Roots}(\mathcal{F})} \text{leaves}(R) = U$）。
- **複合主体の封印不変性（Immutability of Sealed Composites）**: 一度統合により生成した複合主体に対し、後から別主体を追加したり一部のみを引き抜いたりする破壊的変更を禁止し、部分分離は「元の複合主体 $P$ の解体（`Unmerge(P)`）＋残余要素からの新規複合主体 $P'$ の構築（`Merge(remaining -> P')`）」として表現すること。
- **内部 ID と表示名の直交分離および未参照 ID/メモリの安全な再利用**: 探索空間内で同じ構成を持つ複合状態には決定論的に同一の内部 ID を与え（ハッシュコンシング）、未参照となった探索状態は GC により自然に解放可能とすること。
- **後方互換性**: 既存の保存済みプロジェクト JSON に含まれる `'subject_others'` や `group_*` / `merged_entity_*` を読み込み・マイグレーション時に透過的に扱えること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1（従来方式の局所パッチ）**:
  - 平坦な `Map<leafId, bucketId>` と固定 ID `'subject_others'`・実在親 ID 流用を維持したまま、`<=` を `<` に直す等の個別条件を追加する案。
  - 却下理由: 複合主体の封印不変性や実在主体 $T$ 吸収時の変質防止を満たせず、多段統合 `M3, M4 -> M5` の中間構造も失われるため不採用。
- **選択肢2（内容アドレス付き親ポインタ複合森 `SubjectCompositeForest` ＋ 内部ID/表示名完全分離 ＋ `(a)` `cmp_agg_<hash>` 統一）**:
  - 統合状態を親ポインタ木構造（Laminar Forest）で表現し、実在親ロールアップ・役割グループ・周辺主体集約のすべてに内容アドレス ID（`cmp_<12hex>` / `cmp_agg_<12hex>`）を採番して表示名と完全分離する案。
  - 採用理由: 構造的に葉の重複所属が不可能となり、Merkle ルート署名による経路非依存探索・多段木構造保存・OLAP 透過展開・部分分割 $P \to P'$ 再構築を単一の数理モデルで完結できるため採用。

## 4. 決定事項 (Decision Outcome)

### 4.1 内容アドレス付き複合アイデンティティと表示名の分離

すべての統合操作（Poset 上位包摂・役割/人機グループ・手動強制統合・部分分割後の残余再構築・周辺主体集約）において、生成される複合主体には構成内容から一意に定まる内容アドレス ID を付与し、`VTAEntity.name`（図面表示名）から完全に分離する。

$$\text{contentKey}(S) = \text{mode} \;\|\; (\text{coreEntityId} \ ?? \ \text{""}) \;\|\; \text{sort}(\text{compositeOf}(S)), \qquad \text{id}(S) = \begin{cases} \texttt{cmp\_agg\_}\langle 12\text{hex}\rangle & (\text{mode} = \texttt{agg}) \\ \texttt{cmp\_}\langle 12\text{hex}\rangle & (\text{mode} = \texttt{cmp}) \end{cases}$$

1. **実在主体 $T$ による子孫吸収**: `coreEntityId: T` を記録しつつ内部 ID は `cmp_<12hex>`（$\neq T$）を採番し、表示名に $T$ の名称を引き継ぐ。$T$ が段階的に $C_1$, 次いで $C_2$ を吸収する各段階でも構成が変わるため異なる内部 ID として識別される。探索中は `SubjectCompositeRegistry` により同一構成キーのノードをハッシュコンシング共有する。
2. **「その他の関係者」の統一（方式 `(a)`）**: `mode: 'agg'`, `kind: 'other'`, `aggregate: true`, 表示名 `その他の関係者` を持つ `cmp_agg_<12hex>` として統一し、コードベース内のリテラル `'subject_others'` 判定を述語 `isPeripheralAggregateEntity` / `isPeripheralAggregateId`（レガシー `'subject_others'` 互換）へ全面移行する。

### 4.2 親ポインタ複合森（`CompositeForestState`）と二重パーティション検証

1. **単一親ポインタ不変条件**: 森の各ノード $v$ は高々1つの親 `parentOf.get(v) ∈ NodeId ∪ {null}` を持ち、`parentOf.get(R) === null` である根集合 $\text{Roots}(\mathcal{F})$ が VTA 図上のアクティブレーンと 1 対 1 に対応する。基本遷移は根同士の封印統合 `Merge(R_1, ..., R_k -> S)`（$k \ge 2$）と根の1段解体 `Unmerge(S)` のみに限定され、作成済み複合ノードへの事後追加や内部ノードの重複参照は構造的に拒否される（候補トークンの葉展開時も `resolveExactCoverRoots` により既存根の完全被覆 $\bigcup_{R} \text{leaves}(R) = S_{\text{req}}$ を満たさない部分重複は棄却する）。
2. **部分分割の $P'$ 再構築**: $P = \{C_1, C_2, C_3, C_4\}$ から $\{C_2, C_3\}$ を分離する操作（`splitEntitiesLocally` およびピーリング候補 `_aux`）は、`Unmerge(P)` 後に残余要素が 2 件以上であれば新たな内容アドレス ID を持つ $P' = \text{Merge}(C_1, C_4)$（`coreEntityId` なしの場合は `${baseName}（${splitNames}を除く）`）を生成し、残余が 0〜1 件の場合は単体原子主体へ展開する。
3. **二重ランタイム不変条件検査**: 投影前の森に対する `assertAtomicPartitionInvariant`（$O(|U|)$ 全単射葉到達検証）と投影後の `VTAEntity[]` に対する `assertProjectedEntitiesPartition` により、最細度主体の複数レーン跨りおよび欠落がゼロであることを二重保証する。

### 4.3 厳格 Poset 包含検証と全被覆上位ハブ逆転の根絶

1. **実在主体ターゲットへの厳格包含条件**: 既存主体 $T$ を統合先とする候補は、$T$ が `person` でなく、かつすべての統合元葉 $u$ が厳密に $u \prec T$（`poset.isAncestor(T, u)`）を満たすことを必須とする。これにより `M8: A_JA722A (machine) -> A_CAPT_A (person)` のような非包含吸収を確定的に排除し、人間と機械の統合を複合システム（`role_group` / V字複合ハブ）へ誘導する。
2. **真部分集合条件による上位法人逆転防止**: `projectForestToSchema` において複合ノード `comp` の下位へ接続する未実体化 0 イベントハブ $h$ を **真部分集合**（$0 < |D(h)| < |\text{comp.leafIds}|$）に厳格限定する。全葉を被覆する共通上位ハブ（例: `bp8u` の `A_JAL`）は `discoverConservativeParent` の極小共通祖先（`MCA`）として `comp ≺ A_JAL` の正しい上下関係で接続される。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 最細度主体の複数レーン重複所属・複合主体の破壊的変更・`machine -> person` 誤吸収・全被覆親ハブの上下逆転が構造的に根絶される。
  - 多段統合 `M3, M4 -> M5` の中間複合階層が `VTALaneConsolidationState.composites` および `SubjectPoset` 上にそのまま保存され、OLAP ドリルダウン（`getDrilldownSubEntities`）や AI 診断（`aiDiagnostics.ts`）から中間・葉の両レベルを追跡できる。
  - 根 ID 群のソート列自体が木構造全体の正準 Merkle 署名となるため、山登り探索の重複状態排除が $O(L \log L)$ で厳密に機能する。
- **トレードオフ・考慮事項**:
  - Poset ロールアップ後の主体 ID や「その他の関係者」の ID が固定文字列ではなく `cmp_<12hex>` / `cmp_agg_<12hex>` となるため、呼び出し側・テストコードではハードコード ID 比較ではなく `coreEntityId` または `isPeripheralAggregateEntity` / `isPeripheralAggregateId` を用いる。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/features/vta/utils/subjectCompositeForest.ts`（新規）
  - `src/tools/vta/features/vta/utils/subjectCompositeForest.test.ts`（新規）
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts` / `laneConsolidationOptimizer.test.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts` / `subjectRanking.test.ts`
  - `src/tools/vta/features/vta/utils/presentation.ts`
  - `src/tools/vta/features/vta/utils/subjectPoset.ts`
  - `src/tools/vta/features/vta/utils/laneOrder.ts`
  - `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`
  - `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `tests/vta/forceMergeLanes.test.tsx`, `tests/vta/consolidatedSubjectDrilldown.test.ts`, `tests/vta/subjectRankingMachineSuppression.test.ts`, `src/tools/vta/services/generation/granularityRefinement.test.ts`
