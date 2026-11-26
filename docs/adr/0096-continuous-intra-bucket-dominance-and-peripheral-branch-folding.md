# ADR-0096: 桶内相対支配度に基づく連続包含罰金モデル・周辺Poset枝／封緘複合ルートの `cmp_agg_*` 集約適格性および反鎖閉包ゲート（`HG2d`）ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`laneConsolidationOptimizer.ts`)
- **関連ドキュメント・コミット**: [ADR-0080](./0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md), [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0094](./0094-partition-objective-collective-hub-coverage-and-candidate-peeling.md), [ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md)

## 1. コンテキストと課題 (Context & Problem Statement)

[ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md)（Stage 1）により、全統合操作を内容アドレス付き複合主体森（`SubjectCompositeForest`）と `Merge` / `Unmerge` の2プリミティブへ統一し、内部IDと表示名の完全分離・最細度主体の単一レーン所属保証・非包含吸収（`machine -> person`）の棄却を達成した。一方で、大規模シナリオ（`羽田事故` 21主体等）の最適化品質に関して、以下の2点の構造的課題が残存していた。

1. **`[推奨統合]` における不連続なステップ免除と0イベント上位ハブへの主役呑み込み**:
   従来の `computeInclusionPenalty` は、`[推奨統合]` の `poset_rollup` に対して `yEvs >= 1 && rhoDom > 0.5 && rScore > 0.5` という不連続な閾値判定のみで免除可否を切り替えていた。そのため、上位組織 $Y$ が直接イベント0件の純粋上位ハブ（`yEvs === 0`）である場合や閾値境界付近にある場合に、単独の指示・変動連鎖を多数担う主要当事者 $X$（例：`タワー東`）が1カードの周辺席（`グラウンド東`・`デリバリー`）と一括で `[推奨統合]` されると $P_{\text{sub}} = 0$ となり、主役レーンが消失するリスクがあった。また、0イベント上位ハブに対する過広 `[推奨統合]` には `HG2c`（全子孫完全包摂）との整合を保った別構成主体 $P'$ へのピーリング経路がなかった。
2. **周辺Poset枝および0イベント周辺サブハブの `その他の関係者`（`cmp_agg_*`）集約不能による主役側の過剰圧縮**:
   従来の `buildSubjectOthersEligibilitySet` は、アクティブなPoset親または2子孫以上の0イベントPosetハブを持つ下位主体を一律に `subject_others` 不適格としていた。さらに、0イベント法人ハブ（例：`海上保安庁`）配下で別サブコホート（例：`JA722A搭乗員`）に分離されている主役との事前連絡まで同一コホート結合とみなしていた。その結果、純粋な周辺組織枝（例：`羽田航空基地`＋`羽田通信`）や純粋周辺0イベントハブ（例：`東京進入管制所` 配下の `DF`＋`AFS`）が `cmp_agg_*` へ一切入れず、目標レーン数 $K$ を満たすために主役側の航空機・乗務員コホートが過剰圧縮される問題が生じていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **連続数理モデルの原則（VTA Design Principles）**: 主体種別のアドホックな条件分岐やカード枚数カットオフを追加せず、5軸主体重み $s(u)$ と事象関与集合に基づく滑らかな連続関数で包含罰金を定式化すること。
- **半順序反鎖不変条件（`HG2c` / `HG2d`）の厳守**:
  - 0イベント上位ハブの部分包摂を許さず、主役を分離した残余メンバーを束ねる場合は未知の別構成主体 $P'$（`role_group`）として保守的Poset拡張（$P' \prec H$）を行うこと。
  - 周辺枝を `cmp_agg_*` へ集約する際、片方のみが `cmp_agg_*` に入りアクティブな親子片方が外部レーンに取り残される半順序逆転・分断を構造的に禁止すること。
- **複合主体森の封緘不変性**: 既に `cmp_*` として封緘された周辺サブハブ（例：`東京進入管制所`）を破壊・平坦化せず、入れ子複合ノードのまま `cmp_agg_*` の子ノードとして統合可能にすること。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1（不採用）**: `[推奨統合]` の免除自体を全面廃止する。
  - 同質な被災作業員群（`VIC_A, VIC_B -> HUB_VIC`）や共同操縦ペア（`機長B, 訓練乗員 -> 運航乗務員`）の自然な上位統合まで過剰な $P_{\text{sub}}$ 罰金を受け、正当な列削減が阻害される。
- **選択肢2（不採用）**: すべての下位主体を無条件に `cmp_agg_*` 適格とする。
  - アクティブな主役親組織（例：`東京飛行場管制所`）を外部レーンに残したまま一部の下位席のみが `その他の関係者` へ流出し、組織軸が分断される。
- **選択肢3（採用）**: 5軸重み $s(u)$ と単独関与率 $\sigma_{\text{solo}}$ に基づく**連続的な桶内相対支配度 $d(X, B)$** による包含罰金割引と、0イベント推奨統合からの別構成主体 $P'$ ピーリング、および**純粋周辺Poset枝・封緘複合ルートの `cmp_agg_*` 適格化＋反鎖閉包ゲート `HG2d`** を組み合わせる。

## 4. 決定事項 (Decision Outcome)

### 4.1 連続的な桶内相対支配度 $d(X, B)$ による包含罰金 $P_{\text{sub}}^{\text{eff}}(X \to B)$ と0イベントハブ $P'$ ピーリング
1. クリーンな2主体人間・機械V字0イベントハブ（`isCleanManMachineHub`）は1名の操作者と1台の機械の対であるため $P_{\text{sub}}^{\text{eff}} = 0$ とする。
2. 明示的な `[推奨統合]` Posetロールアップ（非 `reporter`・中間アクティブ親飛び越しなし・0能動親逆転なし）に対しては、5軸重み $s(u)$ と事象・能動関与量を統合した連続活動重み $a(u) = s(u) + 0.12|E(u)| + 0.08|E_{\text{act}}(u)|$ および桶内他メンバー集合 $B' = B \setminus \{X\}$ に対する単独イベント比率 $\sigma_{\text{solo}}(X, B') = \frac{|E(X) \setminus E(B')|}{|E(X)|}$ を用いて連続的な桶内相対支配度 $d(X, B) \in [0, 1]$ を定義する：
   $$c_{\text{parity}}(B') = 1.35\,\bar{a}(B'),\qquad d_w(X, B') = \frac{\max\bigl(0,\; a(X) - c_{\text{parity}}(B')\bigr)}{\max(\epsilon,\; a(X))}$$
   $$d(X, B) = \mathrm{clamp}_{[0, 1]}\bigl(2.2 \cdot \sigma_{\text{solo}}(X, B') \cdot d_w(X, B')\bigr),\qquad P_{\text{sub}}^{\text{eff}}(X \to B) = \min\bigl(0.92,\; d(X, B)\,P_{\text{sal}}(X) + P_{\text{dom}}(X, Y)\bigr)$$
   - 同質ピア群（$s(X) \approx s(v)$）や共同操縦ペアでは $d_w = 0 \implies d(X, B) = 0$ となり滑らかに免除される。
   - 0イベント上位ハブであっても、`タワー東` のように単独関与率・5軸重みが桶内他メンバーを圧倒する主役に対しては $d(X, B) > 0$ により $P_{\text{sal}}(X)$ が連続的に復元される。
3. 0イベント上位ハブ $H$ に対する過広な `[推奨統合]` 候補から主役をピーリングする際、残余が2主体以上であれば `targetEntityId` を外した別構成主体 $P'$（`kind: 'role_group'`, 表示名 `${H.name}（${peeledOut}を除く）`）を生成し、`HG2c` を破らずに $P' \prec H$ として統合可能にする。

### 4.2 純粋周辺Poset枝・封緘複合ルートの `cmp_agg_*` 集約適格性と `HG2d` 反鎖閉包ゲート
1. **サブコホート分離を考慮した周辺適格性2パス判定（`buildSubjectOthersEligibilitySet`）**:
   - 0イベント法人アンブレラ $H$（例：`海上保安庁`）配下であっても、主役 $w$（非機械）が固有の0イベント中間サブハブ $M$（$w \prec M \prec H,\; u \not\prec M,\; |D(M)| \ge 2$、例：`JA722A搭乗員`）に分離されていれば、別枝の地上支援組織 $u$（例：`羽田航空基地`・`羽田通信`）を同一現場班コホートとして誤除外しない。
   - アクティブなPoset親 $A$ を持つ下位主体 $u$ は、すべてのアクティブ祖先 $A$ とそのアクティブ部分木 $D(A)$ 全体が純粋周辺適格（`⊆ intrinsicallyPeripheral`）であるときに限り `eligibleOthersSet` に含める。これにより `羽田航空基地 + 羽田通信` は一括で適格となる一方、主役 `タワー東` を抱えるアクティブ親 `東京飛行場管制所` 配下の `グラウンド東` 等は `その他の関係者` へ流出せず管制グループ側に留まる。
2. **封緘複合ルート単位の `cmp_agg_*` 集約と `HG2d` 反鎖閉包ゲート**:
   - `applyCandidatesToForest` の周辺集約遷移で封緘済み複合ルートの完全被覆解決（`allowSealedRootExactCover = true`）を許可し、`generateStructuralFallbackCandidates` でも純粋周辺0イベントハブ（`[hub.id]`）および純粋周辺部分木単位のフォールバック候補を生成することで、`cmp(東京進入管制所)` 等の封緘複合ノードを破壊せず入れ子のまま `cmp_agg_*` へ統合可能にする。
   - `evaluateState` に `HG2d` / `HG2e` ゲートを導入し、(1) `cmp_agg_*` 内の葉のアクティブPoset祖先が外部レーンに残る状態、(2) 純粋周辺アクティブ部分木の親のみが `cmp_agg_*` に入り周辺子が外部に残る状態、(3) 純粋周辺0イベントハブの子孫が一部のみ `cmp_agg_*` に入る部分集約状態、および (4) `cmp_agg_*` の全葉が単一の既存非個人Poset主体 $H$ で完全被覆される状態（正準統合先は $H$ であり `その他の関係者` ではない）をすべて不適格として棄却する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 0イベント上位ハブを含む過広な `[推奨統合]` に対してもステップ閾値の不連続性なく主役レーン（`タワー東` 等）が保護され、残余席は別構成主体 $P'$（`東京飛行場管制所（タワー東を除く）`）として `HG2c` を満たしつつ統合される。
  - `羽田事故` 21主体シナリオ（および実測 Gemini Flash 生成TSV）において、`羽田航空基地 + 羽田通信 + 空港消防` や封緘済み `東京進入管制所` が `cmp_agg_*`（`その他の関係者`）へ反鎖整合的に集約され、航空機・乗務員側の過剰圧縮が解消される。
- **トレードオフ・考慮事項**:
  - `HG2d` により純粋周辺枝・純粋周辺0イベントハブの片割れのみを `その他の関係者` へ入れる遷移は棄却されるが、枝一括候補および封緘ルート候補が同時生成されるため探索到達性は維持される。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `docs/adr/0096-continuous-intra-bucket-dominance-and-peripheral-branch-folding.md`
  - `docs/adr/README.md`
