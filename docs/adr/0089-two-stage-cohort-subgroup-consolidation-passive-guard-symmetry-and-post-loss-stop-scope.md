# ADR-0089: 共通0イベント上位枠配下の補助サブグループ2段階統合・受動役割ガード対称化・および一次損失直後の停止操作の帰結非昇格ポリシー

- **ステータス**: Accepted（第4節1〜2項の仮想グループ葉展開・`isMonotoneVirtualSuperset` 平坦化は [ADR-0095](./0095-content-addressed-composite-forest-and-identity-display-separation.md) により封緘複合ノード入れ子木遷移へ発展置換）
- **決定日**: 2026-11-25
- **対象コンポーネント**: VTA Engine (`laneConsolidationOptimizer.ts`, `subjectRanking.ts`), LLM Prompts (`eventPrompts.ts`, `public/prompts.json`), AI Diagnostics (`aiDiagnostics.ts`)
- **関連ドキュメント・コミット**: [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0078](./0078-llm-driven-event-scope-zero-event-poset-hubs-and-symmetric-recovery-guard.md), [ADR-0084](./0084-poset-antichain-pure-upper-hubs-and-man-machine-composite-subjects.md), [ADR-0087](./0087-formal-poset-parent-discovery-passive-hub-detection-and-temporal-before-ordering.md), [ADR-0088](./0088-isolated-collective-hub-repair-two-stage-convex-load-conservation-and-others-transitivity-guard.md)

## 1. コンテキストと課題 (Context & Problem Statement)

`ADR-0088` 導入後の実機診断トレース（`extract_full_1795588415360_7rnw`：東武鉄道日光線新鹿沼駅構内 除草薬散布作業中の列車触車事故、最細粒度12列・目標7列）において、親子レーン並立（Antichain違反）と幾何エラーは完全に解消された一方、以下の2つの構造課題が確認された。

1. **共通0イベント上位枠配下における仮想サブグループ間の第2段階統合の欠落と非連結停滞（`12列 → 8列` 止まり、`C1 = 0.7519`）**:
   - LLM の `[推奨統合]` は `M1(A14,A15 -> A13)`、`M2(A2,A3 -> subject_others)`、`M3(A7,A8 -> 中継見張員)`、`M4(A9,A10 -> 待避作業員)` を出力し 12列 → 8列まで削減したが、上位枠 `A4（除草薬散布作業班）` には主要当事者（`A作業指揮者`・`B列車見張員`・`G現場代理人`・`H・I・J作業員`）が残存するため `HG2c`（0イベント上位枠の完全包摂条件）により `A4` への部分統合は許されない。
   - さらに ① `parseLaneConsolidationTSV` が先行する仮想 `role_group` 名・IDを参照した `[予備候補]` を細粒度葉IDへ展開できず破棄していた点、② `applyCandidatesRaw` が既存の仮想 `role_group` バケットに属する葉を上位の仮想グループ（厳密上位集合）へ再束ねする単調遷移を `conflict` として拒絶していた点、③ LLM が第2段階の `[予備候補]` を省略した場合に同一コホート配下の補助サブグループ対を束ねる決定論フォールバックが存在しなかった点、④ `evaluateMergeGuard` / `pureAdverseIds` で負の変動イベントの受動役割（`:target` / `:intended_recipient`）が能動逸脱と同一視され不要な `strictAsymmetry` ハード分離を生じ得た点が複合していた。
2. **一次損失発生直後の事後停止操作（`E28: 異音感知・非常停止`）の `outcome:recovery` 誤分類**:
   - `E27:loss（列車触車）` と `E29:loss（作業員4名死亡確認）` の間に位置する衝突後の規定非常ブレーキ操作が `[帰結]`（または Stage 1b `[仮判定]` からの自動昇格）で `outcome:recovery` と判定され、一次損失を防ぎ得なかった通常の事後停止行動がレジリエンス回復帰結バッジを持つ意味的歪みが生じていた。

## 2. 決定理由の要因・制約 (Decision Drivers)

- **統一数理モデルと保守的Poset拡張の厳守（`AGENTS.md`）**:
  - `focus !== 'high'` のようなアドホックな真偽値ルールを積み重ねず、主体重み $s(u)$・Poset距離 $\delta_{\text{poset}}$・主体間関係重み $W(S_1, S_2)$ に基づく連続コストモデルと、未知の0イベント親の発見（保守的Poset拡張）として定式化する。
  - `HG2c`（0イベント上位枠の部分統合禁止：`emhu` テスト）および `targetMaxSubjects = 8` 時の非過剰統合（`b4k9` / `8kxr` テスト）を完全に維持し、凸負荷のただ乗り（$\Delta L = 0$）を防止する。
- **Stage 1a / Stage 1b 一貫した帰結回復スコープ**:
  - Stage 1a の `[帰結]` だけでなく Stage 1b の `PRELIMINARY_CLASSIFICATION_PROMPT`（`promotePreliminaryOutcomes` による再昇格経路）も同時に統一する必要がある。

## 3. 検討した選択肢 (Considered Options)

- **選択肢1**: 0イベント上位枠 $H$ への部分 `poset_rollup` を自動的に `role_group` へ変換する。
  - 却下。`HG2c` の反鎖完全性ガードを迂回し、極小コストの部分統合候補（`emhu` の `P_BAD`）を誤採択させる退行を招く。
- **選択肢2**: 仮想グループ展開時の累積コスト保持・`applyCandidatesRaw` での厳密上位仮想グループ遷移と正増分凸負荷下限・共通0イベント上位枠配下の推奨サブグループ対からの数理コスト合成・受動役割ガード対称化・および `event-ledger-24` での事後停止操作スコープ明確化を組み合わせる。
  - **採用**。既存テストと完全互換を保ちつつ、探索経路非依存かつ数理的に一貫した2段階統合を実現できる。

## 4. 決定事項 (Decision Outcome)

1. **`parseLaneConsolidationTSV` における先行仮想 `role_group` 参照の葉展開と累積コスト保存**:
   - `role_group` 候補が先行する仮想 `role_group` の候補IDまたは `targetLabel` を `sources` に指定した場合、細粒度主体ID集合へ展開するとともに、下位グループのコストを $c_{\text{expanded}} = \min(1, c_{\text{raw}} + \sum_{g \in G_{\text{exp}}} c_g)$ として累積する。
2. **`applyCandidatesRaw` における厳密上位仮想グループ単調遷移と正増分凸負荷下限**:
   - 統合先が仮想グループであり、移動元葉が属する既存サブグループ（仮想グループまたは0イベント中間ハブ、`subject_others` を除く）の全メンバーが移動対象集合 $S_{\text{fine}}$ に真に含まれる場合（`isMonotoneVirtualSuperset`）に単調粗視化遷移を許可する。
   - 既存の $B_{\text{prev}}$ バケットを統合する際の目標合計凸負荷を
     $$L_{\text{target}} = \max\!\Big(\text{stepIncrementalLoad},\; L_{\text{prevSum}} + \max(1, B_{\text{prev}} - 1) \cdot \phi\!\big(\tfrac{c}{\max(1, |S_{\text{moved}}| - 1)}\big)\Big)$$
     と定め、ただ乗り（$\Delta L = 0$）と初期状態直接遷移とのコスト逆転を防止する。
3. **Tier-1 上限超過時における共通0イベント上位枠配下の補助サブグループ対の数理的2段階合成**:
   - `searchOptimalLaneConsolidation` において、Tier-1 候補プール（LLM提案＋既存Poset上位枠＋`subject_others`）の最良分割が目標列数 `targetK` を超過している場合（$L^*(\mathcal{C}_1) > \text{targetK}$）に限り、未統合の他メンバーを残す共通0イベント上位枠 $H$ 配下の互いに素な `[推奨統合]` サブグループ対 $(g_1, g_2)$（`pinned`・`reporter`・非機械 `:loss` 直接関与者および `hard` 分離ペアを含まないもの）に対し、既存候補と重複しない場合のみ両サブグループバケット `[bid1, bid2]` を統合元とする増分数理コスト $c_{\text{step}} = \min(0.55, 0.20 + 0.22\bar{s} + \delta_{\text{poset}} + 0.06 W(S_1,S_2))$ の Tier-2 `role_group` 候補を展開する。これにより Tier-1 で目標列数に到達済みのケースでの擬似直列線による過剰統合を完全に防ぐ。
4. **`hasAdverseVariation` / `pureAdverseIds` の受動役割除外対称化**:
   - `subjectRanking.ts` と `laneConsolidationOptimizer.ts` の双方で、`hasResilienceOrRecovery` と対称に `:target` / `:intended_recipient` のみの参加を純粋逸脱判定から除外する。
5. **一次損失直後の非常停止操作の `outcome:recovery` 非昇格化（`event-ledger-24`）と診断観測性強化**:
   - Stage 1a（`OUTCOME_EXTRACTION_*` / `AUDIT_SECTIONS_POLICY` / `POST_OUTCOME_SCOPE_POLICY`）および Stage 1b（`PRELIMINARY_CLASSIFICATION_PROMPT`）の双方で、一次損失発生直後の非常停止・緊急制動・電源遮断・通報等の事後停止操作は `[帰結]` の `:recovery` に含めず通常の `[イベント]`（`normal` または二次災害拡大を阻止した場合のみ `variation:resilient`）とする契約へ統一し、`public/prompts.json` を同期する。
   - `lane.consolidation` デバッグ記録および `aiDiagnostics.ts` に `invalidCandidateCount` / `llmCandidatesSummary` を追加する。

## 5. 結果と影響 (Consequences)

- **メリット**:
  - 現場作業班等の大規模コホートにおいて、主要当事者（指揮者・見張員・現場代理人・被災作業員）の独立レーンを一切犠牲にすることなく、補助サブグループ群を目標列数（例：`12列 → 7列`、`C1 = 1.0`）へ綺麗に2段階統合できる。
  - `targetMaxSubjects = 8` のように1段階統合で目標列数に達しているケースでは正の増分凸負荷により8列が維持され、過剰統合を起こさない。
  - 衝突・破損後の規定非常停止が誤って回復帰結（`outcome:recovery`）として表示される現象を Stage 1a / Stage 1b 両面で抑止できる。
- **トレードオフ・考慮事項**:
  - 合成候補は1〜数件のメモリ上候補追加に留まり、追加LLM通信コストは 0 トークン、ビーム探索計算時間は 1ms 未満の増加に収まる。
- **影響を受けるファイル・テスト**:
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`
  - `public/prompts.json`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
  - `src/tools/vta/services/generation/laneConsolidationOptimizer.test.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.test.ts`
  - `src/tools/vta/services/llm/prompts.test.ts`
