# ADR-0072: 2段階主体上限（$K_{\text{pre}} / K_{\text{post}}$）による中間最適化からの `subject_others` 排除および最終フェーズ周辺主体集約ポリシー

- **Status**: `Accepted`
- **Date**: 2026-11-22
- **Target Components**: `VTA Subject Consolidation`, `VTA Granularity Refinement`, `VTA Auto Connection Service`, `VTA Connection Proposal`, `VTA Optimization Settings UI`, `VTA AI Diagnostics`
- **Related Requirements / ADRs**: [ADR-0001](./0001-normalization-classification-phase-separation.md), [ADR-0008](./0008-subject-outcome-sharing-and-non-influential-exclusion-policy.md), [ADR-0010](./0010-subject-poset-dag-and-canonical-inclusion.md), [ADR-0011](./0011-olap-drilldown-and-rollup-for-subject-poset.md), [ADR-0068](./0068-whack-a-mole-sibling-merge-guard-sole-others-unwrapping-and-suppress-hint-accuracy.md), [ADR-0071](./0071-penalty-based-subject-consolidation-and-gentle-lane-cap.md)

---

## 1. コンテキストと課題 (Context & Problem Statement)

東武鉄道日光線新鹿沼駅構内触車事故（`2026-11-22T09:51:10.690Z`）のVTA診断トレース分析により、従来の主体統合パイプラインに以下の構造的課題があることが明らかになった。

1. **中間最適化（Stage 2 粒度反復・Stage 3 接続提案）への便宜的バケット `subject_others`（「その他の関係者」）混入**:
   - 本来のドメイン包摂関係（`SubjectPoset` 上の親組織・チームへの統合）と異なり、`subject_others` はグラフ意味論を持たない表示幅圧縮用の便宜的バケットである。
   - これを Stage 2（`refineGranularity`）の初期・反復中の split/merge 最適化に含めていたため、(a) まだ Stage 3（`autoConnectVTA`）でレーン間接続が出揃っていない段階で上流組織（`A_TOBU_OF`, `A_SUB`）が早期に `subject_others` へ畳み込まれ、(b) Stage 3 の LLM が実名主体ではなく「その他の関係者」レーンを見て接続推論を行うことによる精度低下や、ペナルティ項の調整イタチごっこが生じていた。
2. **接続トポロジー確定前の早すぎる周辺性判定**:
   - ある主体が他レーンとの接続が少なく、かつ接続先が非変動要因（定常契約・手配等）であるか否かは、Stage 3（`proposeVTAConnections` ＋ `chainRepair`）でレーン間接続が確定した後に初めて正確に判定できる。
3. **明示 `merge` 時の Poset 推移冗長辺および診断可観測性の細部課題**:
   - Stage 2 で `merge:A_F->A_WRK` が適用された際、`A_F` と `A_WRK` の双方が `A_CREW` を親に持つ場合に `A_F.parentEntityIds` に `["A_CREW", "A_WRK"]` の推移冗長辺が残っていた。また仮判定一括採用時の重複 `graph.projection` 記録および `variation.classification` 遷移の未出力があった。

---

## 2. 決定理由の要因・制約 (Decision Drivers)

- **意味論的包摂と表示圧縮の責務分離**: 中間フェーズ（Stage 2・Stage 3）では実在するドメイン主体と `SubjectPoset` 包摂関係のみでグラフ構造と接続を確定させ、`subject_others` への集約は全接続確定後の最終フェーズ（Stage 3.5）へ遅延させること。
- **決定論的安全性とハード保護**: 変動要因（確定・仮判定の双方）・帰結・回復の保有主体、報告者、固定主体、および保持済み親子を持つ Poset 階層主体は、いかなるモードでも絶対に `subject_others` へ落とさないこと。
- **$L = K_{\text{post}} + 1$ 境界での単独 `subject_others` 防止**: 1主体のみを `subject_others` にしても $(L - 1) + 1 = L$ で列数は減らず実名を失うだけであるため、新規 `subject_others` 生成には最低2件以上の適格周辺主体を必須とすること。
- **ゼロ追加通信でのフロンティア LLM 併用対応**: LLM による周辺主体提案を選択可能にしつつ、追加の API ラウンドトリップを増やさず Stage 3 接続提案レスポンスに相乗りさせること。
- **完全な可逆性と OLAP ドリルダウン互換**: 最終フェーズでの増分集約後も `mergedFrom`・`*EntityOrigin`・`subjectRanking` を一貫維持し、`revertConsolidation` とドリルダウン展開が 100% 無損失で動作すること。

---

## 3. 検討した選択肢 (Considered Options)

- **選択肢 A（不採用）**: 従来どおり Stage 2 の `solveOptimalSubjectRetention` 内で `subject_others` ペナルティ係数をさらに微調整する。
  - *却下理由*: レーン間接続確定前に `subject_others` を作る構造欠陥が残存し、事例ごとの係数調整イタチごっこを解消できないため。
- **選択肢 B（不採用）**: 最終フェーズで専用の新規 LLM API コールを追加して周辺主体を判定させる。
  - *却下理由*: API レイテンシ・コストが増加し、決定論で十分に判定可能な定常ケースまで通信待ちが発生するため。
- **選択肢 C（採用）**: 統合前上限 $K_{\text{pre}}$ と統合後上限 $K_{\text{post}}$ の2段階上限を導入し、Stage 2〜Stage 3 は `allowSubjectOthers: false` で実名レーンを維持、Stage 3 完了直後の最終フェーズ（`consolidatePeripheralSubjectsToOthers`）で決定論（または Stage 3 相乗りの `[周辺主体候補]` セクション＋決定論ハード保護ガード併用）により周辺主体を `subject_others` へ集約する。

---

## 4. 決定事項 (Decision Outcome)

1. **2段階主体上限（$K_{\text{pre}}, K_{\text{post}}$）と中間フェーズからの `subject_others` 完全排除**:
   - メイン UI の「主体の上限」を統合後上限 $K_{\text{post}}$（`subjectLimit`）とし、統合前上限の既定値を $K_{\text{pre}} = \min(12,\; \max(K_{\text{post}},\; K_{\text{post}} + 3))$（最適化詳細設定モーダルから手動指定も可能）とする。
   - `solveOptimalSubjectRetention` に `allowSubjectOthers: false` モードを導入し、Stage 2（`refineGranularity`）では `SubjectPoset` 包摂ロールアップのみを行って実名レーンを保持する。
2. **最終フェーズ周辺主体集約（`consolidatePeripheralSubjectsToOthers`）**:
   - Stage 3（`autoConnectVTA` のレーン間接続提案＋連鎖補完）完了直後（単体 `reoptimizeVTA` / `consolidateSubjects` 実行時はその末尾）に `consolidatePeripheralSubjectsToOthers` を実行する。
   - **Sub-step B1**: $K_{\text{pre}} > K_{\text{post}}$ により残存していた統合可能な Poset 葉主体（厳密非対称ガードなし）を可視親組織へロールアップする。
   - **Sub-step B2**: なお活動主体数 $L > K_{\text{post}}$ の場合、ハード保護対象（報告者、変動要因［確定＋仮判定 `preliminary.value === 'variation'`］・帰結・回復の保有主体、ピン留め/手動主体、可視親子を持つ Poset 主体）を除外した上で、`variationNeighborSemanticCount === 0`（変動・帰結・回復カードへの意味関係接続が 0）、非多段因果ブリッジ、かつ `semanticCrossDegree <= 2` を満たす周辺主体を抽出し、7要素キー `(isPassiveMachine, llmSuggested, focusTier, semanticCrossDegree, actorEventCount, associationCrossDegree, rankScore)` 昇順で必要数 $m_{\text{req}} = L - K_{\text{post}} + 1$ 件を `subject_others` へ増分統合（`foldEntitiesIntoTargets`）する。適格候補が 2件未満（既存 `subject_others` なし時）の場合は `subject_others` を作らず実名レーンを維持する。
3. **ゼロ追加通信のフロンティア LLM 周辺主体提案モード（`othersConsolidationMode: 'llm_assisted'`）**:
   - 設定で `'llm_assisted'` が選択された場合のみ、`compileConnectionProposalSystemPrompt` に `[周辺主体候補]`（`ID\t主体ID\t原文参照\t理由`）任意セクション出力規約を動的注入し、`parseConnectionProposalTSV` で検証・抽出する。抽出された候補は同一の決定論ハード保護ガードおよび最低2件ガードを通した上で優先集約される。
4. **Poset Hasse 極小化と診断トレーサビリティ強化**:
   - `applyRefinementOps` の `merge` 操作時に `intoEntity` の既存上位祖先を `targetEntity.parentEntityIds` から除去し Hasse 極小性を維持する。
   - `isSubstantiveActorForConsolidation` により `focus: 'low'` でも能動行為・変動・因果関係を持つ主体を実質アクターとして扱い、AI 診断パッケージに `subject.others_consolidation` および `variation.classification` フェーズ遷移を出力する。

---

## 5. 結果と影響 (Consequences)

- **メリット**:
  - Stage 2 の反復最適化と Stage 3 のレーン間接続推論が常に実在するドメイン主体名の上で実行され、`subject_others` 起因のモグラ叩き振動や接続推論劣化が根絶される。
  - 最終フェーズで接続数と接続先の変動有無に基づき形式的・決定論的に周辺主体が集約されるため、予測可能性・説明可能性・再現性が大幅に向上し、フロンティアモデル利用時には意味的周辺判定もゼロ追加通信で活用できる。
- **トレードオフ・考慮事項**:
  - 全主体が変動要因または帰結に直結している高密度シナリオや、適格周辺主体が 1件のみ（$L = K_{\text{post}} + 1$）のケースでは、実名保持と因果可読性を優先して $K_{\text{post}}$ を超過した実名レーンが維持される（意図された安全動作）。
- **影響ファイル**:
  - `src/tools/vta/types/vta.ts`
  - `src/tools/vta/features/vta/utils/subjectRanking.ts`, `src/tools/vta/features/vta/utils/subjectRanking.test.ts`
  - `src/tools/vta/features/vta/utils/optimizationPresets.ts`, `src/tools/vta/features/vta/utils/eventAnalysis.ts`
  - `src/tools/vta/features/vta/utils/connectionProposals.ts`
  - `src/tools/vta/services/generation/granularityScore.ts`, `src/tools/vta/services/generation/granularityRefinement.ts`, `src/tools/vta/services/generation/granularityRefinement.test.ts`
  - `src/tools/vta/services/generation/autoConnectionService.ts`, `src/tools/vta/services/generation/autoConnectionService.test.ts`
  - `src/tools/vta/services/llm/eventPrompts.ts`, `src/tools/vta/services/llm/client.ts`
  - `src/tools/vta/components/control-panel/ScenarioInputSection.tsx`, `src/tools/vta/features/vta/components/OptimizationSettingsModal.tsx`, `src/tools/vta/features/vta/store/vtaStore.ts`
  - `src/tools/vta/services/diagnostics/aiDiagnostics.ts`
