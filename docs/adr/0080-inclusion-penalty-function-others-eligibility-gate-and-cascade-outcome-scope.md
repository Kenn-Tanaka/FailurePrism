# ADR-0080: 包含統合に対する構造罰金関数・`subject_others` 適格性ハードゲート・凸コスト目的関数および仮判定帰結スコープ精緻化ポリシー

- **ステータス**: Accepted
- **決定日**: 2026-11-24
- **対象コンポーネント**: VTA Engine (`laneConsolidationOptimizer.ts`), LLM Prompts (`eventPrompts.ts`, `public/prompts.json`), Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0008](./0008-subject-consolidation-outcome-asymmetry-policy.md), [ADR-0063](./0063-granularity-machine-adoption-hub-exemption-and-parent-others-guard.md), [ADR-0071](./0071-penalty-based-subject-consolidation-and-gentle-lane-cap.md), [ADR-0078](./0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md), [ADR-0079](./0079-fine-grained-first-vta-and-hill-climbing-lane-consolidation.md)

## 1. コンテキストと課題 (Context & Problem Statement)

ADR-0079 導入後の大規模実事例監査（羽田空港衝突事故・31主体・60イベント、`extract_full_1795475999650_e07r`）において、配線幾何違反ゼロと5回通信完走を達成した一方、以下の4点の構造的課題が確認された。

1. **推移的リダイレクトと LLM `peripheral_others` 無検証受理による主要主体の `subject_others` 落ち**:
   中間親を飛び越えるフォールバック候補（`CAPT_B -> JAL`）の適用後に LLM 提案の `JAL -> subject_others` が適用された結果、高焦点かつ `:loss` 被災主体である `JAL` と操縦当事者 `CAPT_B` が一括して「その他の関係者」へ書き換えられた。
2. **包含関係 $X < Y$ における実働主役の誤統合と大規模時の `C2` 線形飽和・目的関数段差**:
   LLM の申告コストや画一的なフォールバックコストだけでは、`focus: "high"` ラベルの多発（31主体中13主体）と実働主役（多イベント・高中心性）の区別がつかず、さらに1手コストの線形加算により周辺整理10件で `C2` が急落し、`L - targetK - 2` の不連続段差により目標超過のまま停止・主役吸収が発生した。
3. **仮判定（`preliminary.classification`）での途中経過の過剰な `outcome:*` 昇格と対処・損害の混同**:
   既知の `[帰結]` が特定済みであるにもかかわらず、終息へ向かう途中の機能低下・操縦対応まで `outcome:loss` に補完昇格して帰結ノードが膨張し、また救出行為と負傷確定が1イベントに混同された。
4. **Stage 1 での上位チーム箱と下位個別主体の重複・代替割当**:
   特定可能な場面で下位メンバーではなく上位チームへ直接割当されたため、一部メンバーが関与0件として除外された。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **連続的な粒度制御と主役保護の両立**: ハード禁止による列削減デッドロックを避けつつ、実働主役 $X$ を上位主体 $Y$（$X < Y$）へ統合する際の因果情報損失を構造罰金関数としてモデル化し、LLM のコスト過小評価に対しても安全網を設ける。
- **二重課金の回避と経路非依存性**: LLM の妥当な中コスト提案を二重課金で阻害しないよう加算ではなく下限エンベロープ（$\max$）とし、多段ロールアップの適用順序に依存しない状態関数とする。
- **`subject_others` の厳格な周辺限定と分野非依存性**: 事故語彙等のドメイン固有ルールを用いず、焦点・役割・Poset 構造のみで `subject_others` 適格性を保証する。

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A**: `focus === 'high'` 主体の上位統合をハード制約で全面禁止する。
  - *不採用理由*: 概要段落に登場する準当事者を含め多数の主体に `high` が付与される事例で、目標レーン数への削減が一切不能になる。
- **選択肢 B**: LLM の `semanticCost` に定額の `focus === 'high'` 罰金を加算する。
  - *不採用理由*: 名目上の `high` と実働主役の差が反映されず、また LLM が既に適正なコストを付けた候補で二重課金が発生する。
- **選択肢 C（採用）**:
  1. 5軸 `rankSubjects` スコア・能動/変動関与数・上下間の活動量比（主従逆転）から算出する包含構造罰金 $P_{\text{sub}}(X \to B)$ を導入し、候補コストとの下限エンベロープ $c_{\text{eff}}(X) = \max(c_{\text{cand}}(X), P_{\text{sub}}(X \to B))$ と1手ごとの凸コスト $\phi(c) = 0.35c + 0.95c^2$ で評価する。
  2. `buildSubjectOthersEligibilitySet`・推移的巻き込み禁止・直近アクティブ親優先フォールバックを導入し、プロンプト契約を分野非依存で精緻化する。

## 4. 決定事項 (Decision Outcome)

### 4.1 包含構造罰金関数 $P_{\text{sub}}(X \to B)$ と統一凸コスト目的関数 (`laneConsolidationOptimizer.ts`)
- バケット $B$ 自体または $B$ 内の同居メンバーに $X$ の Poset 上位主体 $Y$（$X < Y$）が存在する場合（擬似 `role_group` による親子混在を含む。純粋な並列 `role_group` は対象外）、実働主役度ペナルティ $P_{\text{salience}}(X)$（`rankSubjects` スコア $r(X)$・能動数・変動関与数に基づく連続値）と主従逆転ペナルティ $P_{\text{dom}}(X \to Y)$（$|E(Y)| \ge 1$ かつ $|E(X)| \ge \max(5, 2.5|E(Y)|)$ の場合のみ適用し、0件親ハブは阻害しない）から $P_{\text{sub}}(X \to B) \in [0, 0.92]$ を算出する。
- 各被統合主体の実効コスト $c_{\text{eff}}(X) = \max(c_{\text{cand}}(X), P_{\text{sub}}(X \to B))$ に対して凸コスト $\phi(c) = 0.35c + 0.95c^2$ を適用し、ビーム探索とファイナリスト検証の双方で段差のない同一の比較目的関数 `computeConsolidationObjective` を共有する（外部表示スコア `S` は `[0, 1]` の $\sum w_i C_i$ を維持）。併せて `maxSteps` の列数自動スケールと2手複合近傍のコスト昇順ソートを導入する。

### 4.2 `subject_others` 適格性ハードゲートと直近アクティブ親フォールバック (`laneConsolidationOptimizer.ts`)
- `buildSubjectOthersEligibilitySet` により、`high`/`reporter` 焦点、非 `machine` の `:loss` 被災主体、帰結の単独関与主体、非 `low` の能動/被災変動主体、アクティブ上位親を持つ下位主体、および2件以上のカードとアクティブ子孫を持つ親ハブを `subject_others` 不適格とする（バンドル候補は適格IDのみ部分救済）。
- `applyCandidatesRaw` での `subject_others` への推移的リダイレクト巻き込み禁止、`HG3b`（帰結の `subject_others` 単独化禁止）、およびアクティブ中間親を飛び越えない直近親優先 Poset フォールバックを適用する。

### 4.3 分野非依存プロンプト精緻化と診断透明性強化 (`eventPrompts.ts`, `public/prompts.json`, `aiDiagnostics.ts`)
- `EVENT_PIPELINE_PROMPT_VERSION` を `'event-ledger-17'` に更新し、①仮判定での連鎖途中事象の `outcome:*` 誤昇格抑止、②対処行動と確定損害の分離抽出、③Poset 定義時の下位個別主体への優先割当、④`LANE_CONSOLIDATION_SYSTEM_PROMPT` での `peripheral_others` 除外基準を明記する。
- `lane.consolidation` 診断トレースに `appliedMovesSummary`（`ID(sources->target:cost)`）を記録・表示する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - `CAPT_B` や `JAL` のような主要当事者・被災法人が `その他の関係者` へ誤集約される経路が構造的に遮断される。
  - LLM のコスト見積もりに揺れがあっても実働主役の上位吸収と主従逆転統合が抑制され、同時に多数の低コスト周辺統合を行っても `C2` が健全な水準を維持する。
  - 同質の並列役割束ね（`role_group`）や0件親組織ハブはペナルティを受けず引き続き有効に機能する。
- **トレードオフ・考慮事項**:
  - 独立性の高い実働主役が目標列数 $K$ を超えて存在する複雑なシナリオでは、主役保護が優先され $K+1 \sim K+2$ 列程度で緩やかに収束する（利用者がさらに少ない $K$ を指定した場合は準主役から段階的にロールアップされる）。
- **影響ファイル**:
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts` / `laneConsolidationOptimizer.test.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`, `public/prompts.json`, `src/tools/vta/services/llm/prompts.test.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `docs/adr/0080-inclusion-penalty-function-others-eligibility-gate-and-cascade-outcome-scope.md`, `docs/adr/README.md`
