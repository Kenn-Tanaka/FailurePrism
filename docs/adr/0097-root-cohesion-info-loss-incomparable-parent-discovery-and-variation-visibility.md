# ADR-0097: 根単位の凝集度情報損失エンベロープ（$L_{\text{info}}(R)$）・非比較相互作用根対の新規親発見（`SYN_COUPLED_*`）・および因果変動イベント可視性ペナルティポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`laneConsolidationOptimizer.ts`), ADR Index (`0088`, `0089`, `0092`)
- **関連ドキュメント・コミット**: [ADR-0080](./0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md), [ADR-0088](./0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md), [ADR-0089](./0089-two-stage-cohort-subgroup-consolidation-passive-guard-symmetry-and-post-loss-stop-scope.md), [ADR-0092](./0092-poset-preserving-manual-lane-force-merge-via-parent-discovery.md), [ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md), [ADR-0096](./0096-continuous-intra-bucket-dominance-and-peripheral-branch-folding.md)

## 1. コンテキストと課題 (Context & Problem Statement)

[ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md)（Stage 1）および [ADR-0096](./0096-continuous-intra-bucket-dominance-and-peripheral-branch-folding.md)（Stage 2）により、複合主体森の封緘遷移・内部ID／表示名分離・連続桶内支配度 $d(X, B)$・純粋周辺Poset枝の集約が確立された。さらなる大規模・複雑シナリオの検証において、以下の3つの統合品質課題が残っていた。

1. **過小コスト候補による異質・複数高サリエンスコホートの1レーン過剰圧縮（`B-2`）**:
   LLM が複数の高サリエンス集団（例：B機の運航乗務員・客室乗務員・乗客・機体）を低い意味コストで1つの `role_group` にまとめた場合、操縦室事象と客室非常脱出事象の共起がほぼゼロであるにもかかわらず情報損失が `C2` に十分反映されず、1レーンへ潰れる場合があった。一方、単純加算で情報損失を課すと正当にコスト付けされた2段階統合（`xrrp` 等）で二重計上が生じる。
2. **Poset 上で共通祖先を持たない相互作用補助根同士の上位親発見不能（`B-1 ③`）**:
   `東京飛行場管制所`（タワー東を除いた補助席群）と `東京進入管制所`（`DF`・`AFS`）のように、Poset 上の共通親を持たないが直接の移管関係 $W(U_1, U_2) > 0$ で結ばれる補助部門対に対し、LLM 候補の欠落や通信失敗時に管制系上位枠を発見する構造候補が存在しなかった。
3. **帰結へ至る因果悪化変動イベントの `その他の関係者` への完全埋没（`C`）**:
   帰結イベントには `HG3b`（`cmp_agg_*` 単独配置の禁止）がある一方、帰結へ因果到達する有効な悪化変動イベント（例：単独主体による見張員減員編成決定）が `cmp_agg_*` のみに置かれると、直列スパインを持たない集約レーン上で因果の起点が埋没する問題があった。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **二重計上の完全排除と森の入れ子形状への非依存性**: 凝集度情報損失は内部ノード単位ではなく**根（最終レーン葉集合 $S = \mathrm{leaves}(R)$）単位の下限エンベロープ**として定義し、帰結非対称（`structuralSoftSepPairs`）との重複計上および入れ子木と平坦木の間の歪みを完全に防ぐこと。
- **形式数理モデルの維持**: 関係重み $W(U_1, U_2)$・共起重複率・2次サリエンスエネルギー $s(u)^2$・因果到達グラフのみを用い、ドメイン固有語彙や固定主体種別ルールを用いないこと。
- **既存回帰スイートとの完全整合**: 共同関与者が名前付きレーンに存在する派遣イベント（`yp2l`・`8kxr`）や適正コストの2段階統合（`xrrp`・`7rnw`）の挙動を一切損なわないこと。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1（不採用）**: 複合森の各内部ノードごとに情報損失を加算し、変動イベントの `:actor` を一律ハードゲートで `cmp_agg_*` から除外する。
  - 多段入れ子統合が平坦統合より不利になるほか、名義レーン上に共同関与者が存在する事前派遣組織まで `cmp_agg_*` から弾かれて列数超過を生じる。
- **選択肢2（採用）**: 根単位の凝集度情報損失 $c_{\text{info}}(R)$ を `C2` の下限エンベロープとして組み込み、非比較相互作用補助根対の `SYN_COUPLED_*` 発見候補、および因果到達悪化変動の単独埋没ソフトペナルティを導入する。

## 4. 決定事項 (Decision Outcome)

### 4.1 根単位の凝集度情報損失下限エンベロープ $c_{\text{info}}(R)$（`B-2`）
非集約複合ルート $R$（葉集合 $S = \mathrm{leaves}(R)$, 非受動葉集合 $S_{\text{sal}}$, $|S_{\text{sal}}| \ge 2$、クリーン2主体人機ハブを除く）に対し、Szymkiewicz–Simpson 共起率の平均 $\bar{J}(S)$ と内部関係密度 $\kappa_{\text{rel}}(S) = 1 - \exp\bigl(-0.5\,W_{\text{int}}(S)/\max(1, |S|-1)\bigr)$ から構造凝集度 $\kappa(S) \in [0, 1]$ を定める：
$$\kappa(S) = \min\bigl(1,\; 0.75\,\bar{J}(S) + 0.45\,\kappa_{\text{rel}}(S)\bigr),\qquad \Delta Q(S_{\text{sal}}) = \sum_{u \in S_{\text{sal}}} s(u)^2 - \max_{u \in S_{\text{sal}}} s(u)^2$$
$$c_{\text{info}}(R) = \min\bigl(0.88,\; 0.62\,(1 - \kappa(S))\,\Delta Q(S_{\text{sal}})\bigr)$$
`evaluateState` の `C2` 計算において、根 $R$ の部分木が既に支払った凸負荷＋包含罰金補填の合計 $L_{\text{paid}}(R)$ と $\phi(c_{\text{info}}(R))$ を比較し、$\max\bigl(0,\; \phi(c_{\text{info}}(R)) - L_{\text{paid}}(R)\bigr)$ のみを加算する下限エンベロープとする。

### 4.2 非比較相互作用補助単位対の新規上位親発見（`SYN_COUPLED_*`, `B-1 ③`）
共通 Poset 祖先を持たず比較不能な非主役・非 `:loss` 直接関与の補助単位対 $(U_1, U_2)$ であって、直接の意味関係重み $W(U_1, U_2) > 0$ を持ち `hard` 分離および `evaluateMergeGuard` 違反のない組に対し、連続コスト
$$c_{\text{coupled}}(U_1, U_2) = \mathrm{clamp}_{[0.28,\, 0.46]}\bigl(0.34 + 0.20\,\bar{s}(U_1 \cup U_2) - 0.04\,\min(3,\, W(U_1, U_2))\bigr)$$
で上位最大4件の `SYN_COUPLED_*`（`role_group`）候補を生成し、`discoverConservativeParent` により共通上位親を発見できるようにする。

### 4.3 因果到達悪化変動イベントの可視性ソフトペナルティ（`C`）
意味関係および能動／被災主体内時系列遷移を逆向きに辿って帰結イベントへ到達する非レジリエント有効変動イベント $e$ について：
1. $e$ が名前付き（非 `aggregate`）レーンに1枚も表示されず `cmp_agg_*` のみに孤立する場合、`softPenalty += 0.24` を課す。
2. 名前付きレーンに受動共同関与者が残る場合でも、$e$ の全 `:actor` が `cmp_agg_*` に入る場合は緩やかなタイブレーク（`+0.04`、上限 `0.08`）を課し、純粋受動周辺主体の集約を優先させる。

### 4.4 関連 ADR の発展置換注記の同期
[ADR-0088](./0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md)・[ADR-0089](./0089-two-stage-cohort-subgroup-consolidation-passive-guard-symmetry-and-post-loss-stop-scope.md)・[ADR-0092](./0092-poset-preserving-manual-lane-force-merge-via-parent-discovery.md) のステータス欄に、`ADR-0095` による複合主体森への発展置換範囲を明記した。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 過小評価された全コホート一括候補（例：B機5〜11主体の一括圧縮）が凝集度情報損失エンベロープで確実に退けられ、操縦室＋機体と客室＋乗客の自然な2単位へ分離される一方、適正コストの多段統合では二重計上が一切発生しない。
  - LLM が上位管制統合候補を省略した場合でも、移管関係で結ばれた `東京飛行場管制所`（補助席）と `東京進入管制所` が `その他の関係者` へ散逸せず1つの管制グループに統合される。
  - 帰結に至る単独悪化変動の行為者が `その他の関係者` に埋没せず独立レーンとして維持される。
- **トレードオフ・考慮事項**:
  - `SYN_COUPLED_*` は上位4件に制限されるため探索空間の増加はごく小さく、実行時間への影響は数ミリ秒以内に収まる。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `docs/adr/0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md`
  - `docs/adr/0089-two-stage-cohort-subgroup-consolidation-passive-guard-symmetry-and-post-loss-stop-scope.md`
  - `docs/adr/0092-poset-preserving-manual-lane-force-merge-via-parent-discovery.md`
  - `docs/adr/0097-root-cohesion-info-loss-incomparable-parent-discovery-and-variation-visibility.md`
  - `docs/adr/README.md`
