# ADR-0094: 純粋分割目的関数（$(k-1)/k$ 自由度保存則・凸超過圧力）・集合帰結ハブ正準被覆・高分散候補ピーリングおよび共有変動ガード精緻化ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-26
- **対象コンポーネント**: VTA Engine (`laneConsolidationOptimizer.ts`, `subjectRanking.ts`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0082](./0082-virtual-role-group-cost-parity-protagonist-asymmetry-guard-and-sole-actor-dependency-healing.md), [ADR-0084](./0084-poset-antichain-pure-upper-hubs-and-man-machine-composite-subjects.md), [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0088](./0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md), [ADR-0090](./0090-split-parent-poset-antichain-guard-man-machine-fallback-and-gateway-connect-timeout.md)

## 1. コンテキストと課題 (Context & Problem Statement)

大規模航空・鉄道事故報告書（例: 羽田空港C滑走路衝突事故 `extract_full_1795666053274_lf15`、最細粒度 `32` レーン → 目標 `7` レーン）の診断分析において、既存のレーン統合最適化器と構造ガードに以下の5つの根本課題が確認された。

1. **手続き的コスト累積（経路依存性）と凸超過勾配の消失**:
   - 従来の `searchOptimalLaneConsolidation` は遷移手順に沿って `moveCostByEntity` を手続き的に更新し、さらに探索ループ外に約230行の `Tier-2` 事後合成パスを別途保持していた。同じ最終分割 $\mathcal{P}$ に異なる順序で到達した際に `C2` が変動する可能性があり、また `0` イベント上位ハブ統合（2主体で削減1列）が $2\phi(c/2)$ を課金される一方で仮想 `role_group` が $1\phi(c)$ となる不整合があった。
   - さらに $C_1(L) = \frac{1}{1 + 0.28\Delta + 0.05\Delta^2}$ は大過剰領域（$\Delta = L - K \ge 7$）で微分勾配 $\left|\frac{\partial C_1}{\partial L}\right|$ が急速に減衰（1列削減あたり `+0.0096`）し、正当な補助グループ統合のコスト増分に負けて `14` 列で探索が早期停止していた。
2. **集合帰結受動ハブ（`JA722A搭乗員`）の未カバー残存による親子並立（Antichain 違反）**:
   - 個別乗員 `A6..A10` が全員 `E41:affected`（`:loss`）で抽出済みであるにもかかわらず、集合名義 `A5 (JA722A搭乗員)` が衝突イベント `E35:affected`（`:loss`）を1件だけ保持していたため、`target / intended_recipient` のみに限定していた従来の `computePassivelyCoveredHubIds` をすり抜けて独立レーン化し、`P1(A5, A11 -> JA722A（A機・搭乗員）)` によって個別乗員 `A6..A10` と集合親レーンが並立した。
3. **高分散 `[推奨統合]` バンドルによる主役（`タワー東`）の埋没**:
   - LLM が主役 `A14 (タワー東, 11イベント, s=0.69)` と周辺管制席 `A15..A18, A43`（1〜2イベント）を一括で `M1 -> A13 (東京飛行場管制所, 1イベント)` へ `[推奨統合]` 提案した際、`recommendedPosetPairs` が無条件に包含罰金 $P_{\text{sub}}$ を免除していたため、主役が1イベント親殻へ吸収されるか、あるいはバンドル全体を棄却するかの二択になっていた。
4. **0イベント上位ハブ配下の非主役被災コホート（`{A8, A9, A10}`）の統合候補欠落**:
   - `:loss :affected` を持つ非機械主体を `generateStructuralFallbackCandidates` から一律除外していたため、主役操縦士 `A6, A7` 以外の補助・同乗クルー `{A8, A9, A10}`（1カードのみの `A10` を含む）を束ねる中間コホート候補が生成されなかった。
5. **共同関与した悪化変動イベントによる `evaluateMergeGuard` の偽陽性 `hard` 分離と仮想トークン照合漏れ**:
   - 共同運航する `A24 (機長B)` と `A25 (訓練乗員)` が同一の悪化変動 `E37` に揃って `:actor` 関与し、後の脱出完了 `E45 (:recovery)` に代表して `A24` のみが記載されたケースで、`evaluateMergeGuard` が「悪化変動と回復の混在」と誤認し `strictAsymmetry: true`（`hard` 分離）を発火していた。また `parseLaneConsolidationTSV` の仮想グループID逆引きが `role_group` のみを対象としており、`[分離維持ペア]` 等での参照が `invalidLines` となっていた（AI診断パッケージでも `invalidCandidateLines` が `anomalies` に未昇格であった）。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **純粋分割関数としての経路非依存性**: 評価値 $J(\mathcal{P})$ は遷移順序に一切依存せず、最終分割 $\mathcal{P}$ のみから一意かつ高速（`< 0.2ms`）に定まること。
- **個別条件分岐の排除と形式数理モデルの一貫性（`AGENTS.md` VTA Design Principles）**: 固定イベント数閾値や職種固有ルールを設けず、5軸サリエンス重み $s(u)$・自由度 $(k-1)/k$・Poset 半順序構造・連続支配率 $\rho_{\text{dom}}$ のみで定式化すること。
- **反鎖（Antichain）完全包摂条件と保守的 Poset 拡張の厳守**: 0イベント上位ハブの部分統合による親子並立を禁止しつつ、未知の中間コホート親発見時は既存半順序を破壊しないこと（$\forall x, y \in V,\; x \preceq y \iff x \preceq' y$）。

## 3. 検討した選択肢 (Considered Options)

- **選択肢A（個別ヒューリスティック・閾値パッチの追加）**:
  - `xEvs >= 8 && nAct >= 5` のような離散閾値や `ancSharesLossAffected` 例外フラグを既存の `moveCostByEntity` + `Tier-2` 手続き探索へ追加する案。
  - 却下理由: 経路依存性と2段階ループの複雑性が温存されるうえ、部分的な親ロールアップ例外は親子並立（Antichain 違反）を再発させるため不採用。
- **選択肢B（純粋分割目的関数 $J(\mathcal{P})$ への一本化・集合帰結ハブ正準被覆・高分散候補ピーリング）**:
  - 手続き的 `moveCostByEntity` と `Tier-2` ループを撤去し、自由度保存則 $(k-1)/k$ と凸超過圧力 $\Phi_{\text{excess}}(\Delta; K)$ を備えた純粋分割評価器＋2つの直交候補生成プリミティブへ統合する案。
  - 採用理由: コード構造を単純化しつつ、経路非依存性・反鎖不変条件・主役保護・目標列数への滑らかな収束を単一の数理モデルで同時に満たすため採用。

## 4. 決定事項 (Decision Outcome)

### 4.1 純粋分割目的関数 $J(\mathcal{P})$ と $(k-1)/k$ 自由度保存則・凸超過圧力

`SearchState` から経路依存の `moveCostByEntity` および別建ての `Tier-2` 合成ループを撤去し、分割 $\mathcal{P} = \{B_1, \dots, B_L\}$ のみから決まる状態関数へ統一する。

1. **$(k-1)/k$ 自由度保存則（0イベントハブと仮想グループの完全等価化）**:
   - 候補プールから各葉 $u \to B$ の静的単位削減コスト $c_{\text{cand}}(u \to B)$（多段0イベントハブ経由時は $\phi^{-1}$ による等価単位コスト）を前計算し、実効単位コストを $c_{\text{eff}}(u, B) = \max\bigl(c_{\text{cand}}(u \to B), P_{\text{sub}}(u \to B)\bigr)$ とする。
   - 既存稼働親 $B \in B_m$ への吸収では非親メンバー $k-1$ 件がそのまま加算され、新規/0イベント枠 $B \notin B_m$（$|B_m| = k \ge 2$）では実質削減列数 $k - 1$ に対応させて各メンバーの凸負荷に自由度重み $\frac{k-1}{k}$（ただし主役希釈 $P_{\text{sub}} \ge 0.45$ 時は $1.0$）を乗じる：
     $$L_{\text{sem}}(\mathcal{P}) = \sum_{B_m \in \mathcal{P}} \sum_{u \in B_m \setminus \{B_m\}} w_{\text{dof}}(u, B_m)\,\phi\bigl(c_{\text{eff}}(u, B_m)\bigr)$$
2. **凸レーン超過圧力 $\Phi_{\text{excess}}(\Delta; K)$**:
   - 表示スコア $S(\mathcal{P}) \in [0, 1]$ の尺度を維持したまま、大過剰領域（$\Delta = \max(0, L - K) \gg 0$）でも単調増加する1列削減利得を保つ凸ペナルティを導入する：
     $$J(\mathcal{P}) = S(\mathcal{P}) - \left(0.032\Delta + \frac{0.035\Delta^2}{\max(4, K)}\right) - 0.095\,L_{\text{sem}}(\mathcal{P}) - 0.10\,P_{\text{soft}}(\mathcal{P})$$

### 4.2 集合帰結受動ハブの正準被覆（Canonical Collective Hub Coverage）

`computePassivelyCoveredHubIds` を拡張し、非能動上位ハブ $H$（`:actor` / `:confirmed_recipient` 関与 0件、稼働子孫 2主体以上）の直接未カバーイベントがすべて特定済み帰結イベント（`outcome_kind` 一致）であり、稼働子孫側で同一 `outcome_kind` の `:affected` が既に抽出済みかつ当該帰結イベントに他の実質担い手が存在する場合、$H$ を正準0イベント上位ハブとして扱う。関係端点の引き継ぎ（`remapPassivelyCoveredRelations`）では子孫 → 共通 Poset 祖先ピア → 同一イベント内の他担い手（`affected > target > ...`）の順で安全に解決する。

### 4.3 連続活動支配率ガードと2つの直交候補生成プリミティブ

1. **連続活動支配率ガード（`isSevereShellDominance`）**:
   - 稼働親 $Y$（$n_{\text{ev}}(Y) \ge 1$）に対し子 $X$ が $s(X) > 0.5$ かつ $\rho_{\text{dom}}(X, Y) = \frac{n_{\text{ev}}(X) - 2 n_{\text{ev}}(Y)}{n_{\text{ev}}(X)} > 0.5$ を満たす場合、`[推奨統合]` による $P_{\text{sub}}$ 免除を適用せず連続包含罰金を課す。
2. **高分散バンドルの主役ピーリング（`${id}_aux`）**:
   - 3主体以上のバンドル候補 $C$ において $s(u) \ge 0.5$ かつ $s(u) - \operatorname{median}_{v \in C} s(v) \ge 0.20$ の突出主役が存在する場合、突出主役を独立維持して残余メンバーのみを統合する派生候補を自動生成する。
3. **0イベント上位ハブ配下の非主役コホート単一パス合成（`SYN_COHORT_*`）**:
   - 0イベント上位ハブ $H$（稼働子孫 3主体以上）の配下に主役（`high` / `reporter` / `pinned`）と非主役が混在して `HG2c` により $H$ への部分統合が禁じられる場合、非主役群（`:loss` 直接関与組／非関与組）から `hard` 分離競合のない互換メンバーを束ねる補助 `role_group` 候補を合成する。また `generateStructuralFallbackCandidates` でも同一親を共有する `:loss :affected` 非主役間の補助候補生成を許容する。

### 4.4 共有悪化変動の非対称ガード精緻化と診断可視化

1. **`evaluateMergeGuard` の共有変動除外・同一コホート人機ソフト化**:
   - 比較対象の相手主体が実質的役割で共同関与している悪化変動イベントは「一方のみの排他的過失」とみなさず `hasExclusiveAdverseVariation` から除外する。また共通 Poset 祖先を持つ `machine` と非 `machine` 間の `:loss` 対 `:recovery` 非対称は `strictAsymmetry: false`（`soft` 制約）へ緩和する。
2. **仮想グループ参照の全面展開と `LANE_CONSOLIDATION_INVALID_ROW` 診断**:
   - `parseLaneConsolidationTSV` の仮想グループ逆引きを全候補種別および `[分離維持ペア]` へ拡大し、`aiDiagnostics.ts` で `lane.consolidation` の `invalidCandidateLines` を `LANE_CONSOLIDATION_INVALID_ROW` として `anomalies` に出力する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 探索目的関数が完全な経路非依存の純粋分割関数となり、2段階の重複最適化ループが解消されて保守性と推論透明性が向上した。
  - `lf15` 再現ケースにおいて、`JA722A搭乗員` の親子並立解消、`タワー東` の独立維持と周辺管制群の `航空管制機関` 統合、補助搭乗員 `{A8, A9, A10}` のコホート統合、共同運航乗員 `A24 + A25` の統合がすべて成立し、25細粒度レーンから8〜9レーンへの健全な収束が確認された。
- **トレードオフ・考慮事項**:
  - 0イベント上位ハブへの統合負荷が $(k-1)/k$ 自由度則に統一されたため、従来の $k\phi(c/k)$ 前提の単体検証値は $\phi(c)$ 等価保存則に基づく期待値へ更新される。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `tests/vta/aiDiagnostics.test.ts`
  - `docs/adr/0094-partition-objective-collective-hub-coverage-and-candidate-peeling.md`
  - `docs/adr/README.md`
